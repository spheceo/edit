// The C boundary owns its objects and drains temporary objects on every frame.
// No decoded-frame array, raw-video pipe, or codec process lives behind it.
#import <AVFoundation/AVFoundation.h>
#import <Accelerate/Accelerate.h>
#import <ImageIO/ImageIO.h>
#import <Vision/Vision.h>

static void fail(char *error, size_t capacity, NSString *message) {
    if (capacity) snprintf(error, capacity, "%s", message.UTF8String ?: "AVFoundation failed");
}

int edit_image_info(const char *path, uint32_t *width, uint32_t *height) {
    @autoreleasepool {
        CGImageSourceRef source = CGImageSourceCreateWithURL((__bridge CFURLRef)[NSURL fileURLWithPath:@(path)], NULL);
        if (!source) return 0;
        NSDictionary *properties = CFBridgingRelease(CGImageSourceCopyPropertiesAtIndex(source, 0, NULL));
        *width = [properties[(id)kCGImagePropertyPixelWidth] unsignedIntValue];
        *height = [properties[(id)kCGImagePropertyPixelHeight] unsignedIntValue];
        unsigned orientation = [properties[(id)kCGImagePropertyOrientation] unsignedIntValue];
        if (orientation >= 5 && orientation <= 8) { uint32_t swap = *width; *width = *height; *height = swap; }
        CFRelease(source);
        return *width > 0 && *height > 0;
    }
}

int edit_image_frame(const char *path, uint32_t width, uint32_t height, uint8_t *rgba, size_t length) {
    @autoreleasepool {
        if (length != (size_t)width * height * 4) return 0;
        CGImageSourceRef source = CGImageSourceCreateWithURL((__bridge CFURLRef)[NSURL fileURLWithPath:@(path)], NULL);
        if (!source) return 0;
        CGImageRef image = CGImageSourceCreateThumbnailAtIndex(source, 0, (__bridge CFDictionaryRef)@{
            (id)kCGImageSourceCreateThumbnailFromImageAlways: @YES,
            (id)kCGImageSourceCreateThumbnailWithTransform: @YES,
            (id)kCGImageSourceThumbnailMaxPixelSize: @(MAX(width, height))
        });
        CFRelease(source);
        if (!image) return 0;
        CGColorSpaceRef color = CGColorSpaceCreateWithName(kCGColorSpaceSRGB);
        CGContextRef context = CGBitmapContextCreate(rgba, width, height, 8, width * 4, color,
            kCGImageAlphaPremultipliedLast | kCGBitmapByteOrder32Big);
        CGColorSpaceRelease(color);
        if (!context) { CGImageRelease(image); return 0; }
        CGContextSetBlendMode(context, kCGBlendModeCopy);
        CGContextDrawImage(context, CGRectMake(0, 0, width, height), image);
        CGContextRelease(context);
        CGImageRelease(image);
        // The shared renderer uses straight RGBA, as createImageBitmap does.
        for (size_t i = 0; i < length; i += 4) {
            unsigned alpha = rgba[i + 3];
            if (alpha > 0 && alpha < 255) {
                for (size_t c = 0; c < 3; c++) rgba[i + c] = MIN(255, (rgba[i + c] * 255 + alpha / 2) / alpha);
            }
        }
        return 1;
    }
}

int edit_image_thumbnail(const char *path, const char *output) {
    @autoreleasepool {
        CGImageSourceRef source = CGImageSourceCreateWithURL((__bridge CFURLRef)[NSURL fileURLWithPath:@(path)], NULL);
        if (!source) return 0;
        CGImageRef image = CGImageSourceCreateThumbnailAtIndex(source, 0, (__bridge CFDictionaryRef)@{
            (id)kCGImageSourceCreateThumbnailFromImageAlways: @YES,
            (id)kCGImageSourceCreateThumbnailWithTransform: @YES,
            (id)kCGImageSourceThumbnailMaxPixelSize: @320
        });
        CFRelease(source);
        if (!image) return 0;
        CGImageDestinationRef dest = CGImageDestinationCreateWithURL((__bridge CFURLRef)[NSURL fileURLWithPath:@(output)], CFSTR("public.jpeg"), 1, NULL);
        if (!dest) { CGImageRelease(image); return 0; }
        CGImageDestinationAddImage(dest, image, (__bridge CFDictionaryRef)@{(id)kCGImageDestinationLossyCompressionQuality:@0.85});
        BOOL ok = CGImageDestinationFinalize(dest);
        CFRelease(dest);
        CGImageRelease(image);
        return ok;
    }
}

// Encodes an opaque RGBA picture (rows `stride` bytes apart) as JPEG (`jpeg`,
// at `quality`) or PNG. Returns a CFData the caller releases with
// edit_data_release, or NULL.
void *edit_image_encode(const uint8_t *rgba, uint32_t width, uint32_t height, size_t stride,
                        int jpeg, double quality) {
    @autoreleasepool {
        if (!width || !height || stride < (size_t)width * 4) return NULL;
        CFDataRef pixels = CFDataCreate(NULL, rgba, stride * height);
        CGDataProviderRef provider = CGDataProviderCreateWithCFData(pixels);
        CFRelease(pixels);
        CGColorSpaceRef color = CGColorSpaceCreateWithName(kCGColorSpaceSRGB);
        CGImageRef image = CGImageCreate(width, height, 8, 32, stride, color,
            kCGImageAlphaNoneSkipLast | kCGBitmapByteOrder32Big, provider, NULL, false,
            kCGRenderingIntentDefault);
        CGColorSpaceRelease(color);
        CGDataProviderRelease(provider);
        if (!image) return NULL;
        CFMutableDataRef out = CFDataCreateMutable(NULL, 0);
        CGImageDestinationRef dest = CGImageDestinationCreateWithData(out,
            jpeg ? CFSTR("public.jpeg") : CFSTR("public.png"), 1, NULL);
        BOOL ok = NO;
        if (dest) {
            NSDictionary *options = jpeg ? @{(id)kCGImageDestinationLossyCompressionQuality: @(quality)} : @{};
            CGImageDestinationAddImage(dest, image, (__bridge CFDictionaryRef)options);
            ok = CGImageDestinationFinalize(dest);
            CFRelease(dest);
        }
        CGImageRelease(image);
        if (!ok) { CFRelease(out); return NULL; }
        return (void *)out;
    }
}

const uint8_t *edit_data_bytes(void *data) { return CFDataGetBytePtr((CFDataRef)data); }
size_t edit_data_length(void *data) { return (size_t)CFDataGetLength((CFDataRef)data); }
void edit_data_release(void *data) { CFRelease((CFDataRef)data); }

// Faces in a BGRA picture (Vision's face rectangles, profiles included): up
// to `max` of them into `out` as x0, y0, x1, y1 (0..1 from the top left) and
// confidence, `count` set to how many. The pixels are only read during the call.
int edit_faces(const uint8_t *bgra, uint32_t width, uint32_t height, size_t stride,
               float *out, size_t max, size_t *count) {
    @autoreleasepool {
        *count = 0;
        if (!width || !height || stride < (size_t)width * 4) return 0;
        CVPixelBufferRef pixel = NULL;
        if (CVPixelBufferCreateWithBytes(kCFAllocatorDefault, width, height, kCVPixelFormatType_32BGRA,
                (void *)bgra, stride, NULL, NULL, NULL, &pixel) != kCVReturnSuccess || !pixel) {
            return 0;
        }
        VNDetectFaceRectanglesRequest *request = [VNDetectFaceRectanglesRequest new];
        VNImageRequestHandler *handler = [[VNImageRequestHandler alloc] initWithCVPixelBuffer:pixel options:@{}];
        NSError *problem = nil;
        BOOL ok = [handler performRequests:@[request] error:&problem];
        CVPixelBufferRelease(pixel);
        if (!ok) return 0;
        for (VNFaceObservation *face in request.results) {
            if (*count >= max) break;
            CGRect box = face.boundingBox;  // 0..1, origin at the bottom left
            float *o = out + *count * 5;
            o[0] = box.origin.x;
            o[1] = 1.0 - (box.origin.y + box.size.height);
            o[2] = box.origin.x + box.size.width;
            o[3] = 1.0 - box.origin.y;
            o[4] = face.confidence;
            *count += 1;
        }
        return 1;
    }
}

// High-quality resample of a 4-channel 8-bit picture (any channel order).
int edit_scale(const uint8_t *source, uint32_t sw, uint32_t sh, size_t sstride,
               uint8_t *dest, uint32_t dw, uint32_t dh, size_t dstride) {
    vImage_Buffer from = {(void *)source, sh, sw, sstride};
    vImage_Buffer to = {dest, dh, dw, dstride};
    return vImageScale_ARGB8888(&from, &to, NULL, kvImageHighQualityResampling) == kvImageNoError;
}

@interface EditReader : NSObject
@property AVURLAsset *asset;
@property AVAssetTrack *track;
@property AVAssetReader *reader;
@property AVAssetReaderTrackOutput *output;
@property(nonatomic) CMSampleBufferRef held;
@property(nonatomic) CMSampleBufferRef next;
// The sample last copied out, kept to tell an unchanged picture (slowed clips).
@property(nonatomic) CMSampleBufferRef shown;
@property double requested;
// Read once at open: property reads can load synchronously from the file.
@property double step;
@property double end;
@property uint32_t width;
@property uint32_t height;
@property unsigned rotation;
@property NSMutableData *rotated;
// The track's empty edits (movie seconds): AVFoundation fills each with a
// made-up black picture (alpha 0) that no frame of the source shows. FFmpeg
// writes one at the start of a file whose first picture isn't at 0, as our
// slowed clips' renders are, so a clip from 0 opened on a black frame.
@property NSArray<NSValue *> *gaps;
@end

@implementation EditReader
- (void)dealloc {
    [_reader cancelReading];
    if (_held) CFRelease(_held);
    if (_next) CFRelease(_next);
    if (_shown) CFRelease(_shown);
}
- (BOOL)restart:(double)time error:(NSError **)error {
    [_reader cancelReading];
    if (_held) CFRelease(_held);
    if (_next) CFRelease(_next);
    _held = NULL;
    _next = NULL;
    _reader = [[AVAssetReader alloc] initWithAsset:_asset error:error];
    if (!_reader) return NO;
    // Decode at the required size, avoiding a 4K copy for a 1080p export. BGRA
    // is the decoder's own order: the renderer samples it without a swizzle.
    BOOL quarter = _rotation % 2;
    NSDictionary *settings = @{
        (id)kCVPixelBufferPixelFormatTypeKey: @(kCVPixelFormatType_32BGRA),
        (id)kCVPixelBufferWidthKey: @(quarter ? _height : _width),
        (id)kCVPixelBufferHeightKey: @(quarter ? _width : _height),
        (id)kCVPixelBufferIOSurfacePropertiesKey: @{}
    };
    _output = [[AVAssetReaderTrackOutput alloc] initWithTrack:_track outputSettings:settings];
    _output.alwaysCopiesSampleData = NO;
    if (![_reader canAddOutput:_output]) return NO;
    [_reader addOutput:_output];
    // The video track's own end, not the asset's (a longer sound track would
    // make the range start after the last picture and the read fail).
    double start = MIN(MAX(0, time), MAX(0, _end - _step));
    _reader.timeRange = CMTimeRangeFromTimeToTime(CMTimeMakeWithSeconds(start, 600000),
                                                  CMTimeMakeWithSeconds(MAX(_end, start + _step), 600000));
    return [_reader startReading];
}
// Whether a picture at `time` is an empty edit's filler. The filler starts the
// edit; the source's own next picture may land a hair before the edit's end
// (timescale rounding), so only the edit's first part counts.
- (BOOL)inGap:(double)time {
    for (NSValue *value in _gaps) {
        CMTimeRange gap = value.CMTimeRangeValue;
        double start = CMTimeGetSeconds(gap.start);
        double length = CMTimeGetSeconds(gap.duration);
        if (time >= start - 0.000001 && time < start + length - MIN(_step, length) * 0.5) return YES;
    }
    return NO;
}
// The next sample with a picture: marker and empty samples, and empty edits'
// filler, are skipped.
- (CMSampleBufferRef)copyNextPicture {
    for (;;) {
        CMSampleBufferRef sample = [_output copyNextSampleBuffer];
        if (!sample) return NULL;
        CMTime pts = CMSampleBufferGetPresentationTimeStamp(sample);
        if (CMSampleBufferGetImageBuffer(sample) && CMTIME_IS_NUMERIC(pts) && ![self inGap:CMTimeGetSeconds(pts)])
            return sample;
        CFRelease(sample);
    }
}
@end

void *edit_reader_open(const char *path, uint32_t width, uint32_t height,
                       char *error, size_t capacity) {
    @autoreleasepool {
        EditReader *r = [EditReader new];
        r.asset = [AVURLAsset URLAssetWithURL:[NSURL fileURLWithPath:@(path)] options:nil];
        r.track = [r.asset tracksWithMediaType:AVMediaTypeVideo].firstObject;
        if (!r.track) { fail(error, capacity, @"No native video track"); return NULL; }
        r.width = width;
        r.height = height;
        r.requested = -1;
        r.step = 1.0 / MAX(1, r.track.nominalFrameRate);
        CMTimeRange range = r.track.timeRange;
        double end = CMTIMERANGE_IS_VALID(range) && CMTIME_IS_NUMERIC(range.duration)
            ? CMTimeGetSeconds(CMTimeRangeGetEnd(range)) : CMTimeGetSeconds(r.asset.duration);
        if (!isfinite(end) || end <= 0) { fail(error, capacity, @"Native track has no finite duration"); return NULL; }
        r.end = end;
        NSMutableArray<NSValue *> *gaps = [NSMutableArray array];
        for (AVAssetTrackSegment *segment in r.track.segments) {
            if (segment.empty) [gaps addObject:[NSValue valueWithCMTimeRange:segment.timeMapping.target]];
        }
        r.gaps = gaps;
        CGAffineTransform t = r.track.preferredTransform;
        double angle = atan2(t.b, t.a);
        // vImage's positive rotation is counterclockwise; track transforms use y down.
        r.rotation = ((int)llround(-angle / M_PI_2) + 4) % 4;
        if (t.a * t.d - t.b * t.c < 0) {
            fail(error, capacity, @"Mirrored track requires the compatibility decoder");
            return NULL;
        }
        return (__bridge_retained void *)r;
    }
}

// Copies the frame nearest `time` into `out` (BGRA, or RGBA with `rgba`).
// Returns 1, or 2 without copying when `if_changed` and it is the picture the
// last call copied, or 0 on failure.
int edit_reader_frame(void *handle, double time, uint8_t *out, size_t length, int rgba,
                      int if_changed, char *error, size_t capacity) {
    @autoreleasepool {
        EditReader *r = (__bridge EditReader *)handle;
        if (length != (size_t)r.width * r.height * 4 || !isfinite(time)) return 0;
        NSError *problem = nil;
        double step = r.step;
        // An over-trimmed clip holds its last picture.
        time = MIN(MAX(0, time), MAX(0, r.end - step * 0.5));
        if (!r.reader || time < r.requested - 0.000001 || time - r.requested > 2) {
            // Start a little before the target to have the frame covering it.
            if (![r restart:time - step error:&problem]) {
                fail(error, capacity, problem.localizedDescription ?: r.reader.error.localizedDescription ?: @"Native reader would not start");
                return 0;
            }
        }
        r.requested = time;
        if (!r.held) r.held = [r copyNextPicture];
        if (!r.next) r.next = [r copyNextPicture];
        while (r.next && CMTimeGetSeconds(CMSampleBufferGetPresentationTimeStamp(r.next)) <= time + 0.000001) {
            if (r.held) CFRelease(r.held);
            r.held = r.next;
            r.next = [r copyNextPicture];
        }
        if (!r.held || r.reader.status == AVAssetReaderStatusFailed) {
            fail(error, capacity, r.reader.error.localizedDescription ?: @"No native frame at this time");
            return 0;
        }
        // The nearest picture: right for variable frame rates and for sources
        // whose rate differs from the timeline's.
        CMSampleBufferRef chosen = r.held;
        if (r.next) {
            double before = time - CMTimeGetSeconds(CMSampleBufferGetPresentationTimeStamp(r.held));
            double after = CMTimeGetSeconds(CMSampleBufferGetPresentationTimeStamp(r.next)) - time;
            if (after < before) chosen = r.next;
        }
        if (if_changed && chosen == r.shown) return 2;
        CVPixelBufferRef pixel = CMSampleBufferGetImageBuffer(chosen);
        if (!pixel || CVPixelBufferLockBaseAddress(pixel, kCVPixelBufferLock_ReadOnly) != kCVReturnSuccess) {
            fail(error, capacity, @"Cannot lock decoded pixel buffer"); return 0;
        }
        vImage_Buffer source = {CVPixelBufferGetBaseAddress(pixel), CVPixelBufferGetHeight(pixel),
            CVPixelBufferGetWidth(pixel), CVPixelBufferGetBytesPerRow(pixel)};
        vImage_Buffer dest = {out, r.height, r.width, r.width * 4};
        vImage_Error result = kvImageNoError;
        if (r.rotation) {
            size_t w = r.rotation % 2 ? source.height : source.width;
            size_t h = r.rotation % 2 ? source.width : source.height;
            const uint8_t black[4] = {0, 0, 0, 255};
            if (w == r.width && h == r.height) {
                result = vImageRotate90_ARGB8888(&source, &dest, r.rotation, black, kvImageNoFlags);
            } else {
                if (r.rotated.length != w * h * 4) r.rotated = [NSMutableData dataWithLength:w * h * 4];
                vImage_Buffer rotated = {r.rotated.mutableBytes, h, w, w * 4};
                result = vImageRotate90_ARGB8888(&source, &rotated, r.rotation, black, kvImageNoFlags);
                if (result == kvImageNoError) result = vImageScale_ARGB8888(&rotated, &dest, NULL, kvImageNoFlags);
            }
        } else if (source.width == r.width && source.height == r.height) {
            // The decoder already scaled: one copy, dropping any row padding.
            for (size_t y = 0; y < r.height; y++) {
                memcpy((uint8_t *)out + y * dest.rowBytes, (uint8_t *)source.data + y * source.rowBytes, r.width * 4);
            }
        } else {
            result = vImageScale_ARGB8888(&source, &dest, NULL, kvImageNoFlags);
        }
        const uint8_t channels[4] = {2, 1, 0, 3};
        if (rgba && result == kvImageNoError) result = vImagePermuteChannels_ARGB8888(&dest, &dest, channels, kvImageNoFlags);
        CVPixelBufferUnlockBaseAddress(pixel, kCVPixelBufferLock_ReadOnly);
        if (result != kvImageNoError) { fail(error, capacity, @"Native pixel conversion failed"); return 0; }
        if (r.shown != chosen) {
            if (r.shown) CFRelease(r.shown);
            r.shown = (CMSampleBufferRef)CFRetain(chosen);
        }
        return 1;
    }
}

void edit_reader_close(void *handle) {
    @autoreleasepool { EditReader *r = (__bridge_transfer EditReader *)handle; (void)r; }
}

// ---------------------------------------------------------------------------
// Sound: one stretch of a file's first sound track as 48 kHz stereo float.

@interface EditSound : NSObject
@property AVURLAsset *asset;
@property AVAssetTrack *track;
@end
@implementation EditSound
@end

@interface EditSoundReader : NSObject
@property AVAssetReader *reader;
@property AVAssetReaderTrackOutput *output;
@property(nonatomic) CMSampleBufferRef sample;
@property size_t offset;
@property double start;
// Frames of silence still owed before the first sample (a stream starting late).
@property size_t lead;
// Frames decoded before the stretch's first sample, still to drop.
@property size_t skip;
@property BOOL started;
@end
@implementation EditSoundReader
- (void)dealloc {
    [_reader cancelReading];
    if (_sample) CFRelease(_sample);
}
@end

// A file's sound, opened once and shared by the readers of its stretches.
void *edit_sound_open(const char *path, char *error, size_t capacity) {
    @autoreleasepool {
        EditSound *s = [EditSound new];
        s.asset = [AVURLAsset URLAssetWithURL:[NSURL fileURLWithPath:@(path)] options:nil];
        s.track = [s.asset tracksWithMediaType:AVMediaTypeAudio].firstObject;
        if (!s.track) { fail(error, capacity, @"No native sound track"); return NULL; }
        // More than two channels need a real downmix: the compatibility decoder's.
        for (id description in s.track.formatDescriptions) {
            const AudioStreamBasicDescription *format =
                CMAudioFormatDescriptionGetStreamBasicDescription((__bridge CMAudioFormatDescriptionRef)description);
            if (!format || format->mChannelsPerFrame > 2) {
                fail(error, capacity, @"Sound has more than two channels"); return NULL;
            }
        }
        return (__bridge_retained void *)s;
    }
}

void edit_sound_close(void *handle) {
    @autoreleasepool { EditSound *s = (__bridge_transfer EditSound *)handle; (void)s; }
}

void *edit_sound_reader_open(void *sound, double start, double duration, char *error, size_t capacity) {
    @autoreleasepool {
        EditSound *s = (__bridge EditSound *)sound;
        NSError *problem = nil;
        EditSoundReader *r = [EditSoundReader new];
        r.reader = [[AVAssetReader alloc] initWithAsset:s.asset error:&problem];
        if (!r.reader) { fail(error, capacity, problem.localizedDescription ?: @"Native sound reader unavailable"); return NULL; }
        r.output = [[AVAssetReaderTrackOutput alloc] initWithTrack:s.track outputSettings:@{
            AVFormatIDKey: @(kAudioFormatLinearPCM), AVSampleRateKey: @48000, AVNumberOfChannelsKey: @2,
            AVLinearPCMBitDepthKey: @32, AVLinearPCMIsFloatKey: @YES, AVLinearPCMIsNonInterleaved: @NO,
            AVLinearPCMIsBigEndianKey: @NO}];
        r.output.alwaysCopiesSampleData = NO;
        if (![r.reader canAddOutput:r.output]) { fail(error, capacity, @"Native sound output unavailable"); return NULL; }
        [r.reader addOutput:r.output];
        start = MAX(0, start);
        r.start = start;
        // A little extra either side: the stretch is cut to the sample here.
        r.reader.timeRange = CMTimeRangeMake(CMTimeMakeWithSeconds(start, 48000),
                                             CMTimeMakeWithSeconds(MAX(0, duration) + 0.05, 48000));
        if (![r.reader startReading]) {
            fail(error, capacity, r.reader.error.localizedDescription ?: @"Native sound reader would not start"); return NULL;
        }
        return (__bridge_retained void *)r;
    }
}

// Fills up to `frames` stereo frames from where the last call stopped; sets
// `written` (fewer at the end of the file). Returns 0 on failure.
int edit_sound_read(void *handle, float *out, size_t frames, size_t *written, char *error, size_t capacity) {
    @autoreleasepool {
        EditSoundReader *r = (__bridge EditSoundReader *)handle;
        size_t done = 0;
        while (done < frames) {
            if (r.lead) {
                size_t n = MIN(r.lead, frames - done);
                memset(out + done * 2, 0, n * 2 * sizeof(float));
                done += n; r.lead -= n;
                continue;
            }
            if (!r.sample) {
                CMSampleBufferRef next = [r.output copyNextSampleBuffer];
                if (!next) {
                    if (r.reader.status == AVAssetReaderStatusFailed) {
                        fail(error, capacity, r.reader.error.localizedDescription ?: @"Native sound decoding failed"); return 0;
                    }
                    break;
                }
                if (CMSampleBufferGetNumSamples(next) == 0) { CFRelease(next); continue; }
                r.sample = next;
                r.offset = 0;
                if (!r.started) {
                    // Cut to the exact first sample: a decoder starts at its packet.
                    r.started = YES;
                    double pts = CMTimeGetSeconds(CMSampleBufferGetPresentationTimeStamp(next));
                    long shift = isfinite(pts) ? lround((pts - r.start) * 48000.0) : 0;
                    if (shift > 0) r.lead = (size_t)shift;
                    else r.skip = (size_t)(-shift);
                    if (r.lead) continue;
                }
            }
            CMBlockBufferRef block = CMSampleBufferGetDataBuffer(r.sample);
            size_t count = (size_t)CMSampleBufferGetNumSamples(r.sample);
            if (r.skip) {
                size_t dropped = MIN(r.skip, count - MIN(count, r.offset));
                r.offset += dropped; r.skip -= dropped;
            }
            size_t available = count > r.offset ? count - r.offset : 0;
            size_t n = MIN(available, frames - done);
            if (n && (!block || CMBlockBufferCopyDataBytes(block, r.offset * 2 * sizeof(float), n * 2 * sizeof(float), out + done * 2) != kCMBlockBufferNoErr)) {
                fail(error, capacity, @"Cannot read decoded sound"); return 0;
            }
            done += n;
            r.offset += n;
            if (r.offset >= count) { CFRelease(r.sample); r.sample = NULL; }
        }
        *written = done;
        return 1;
    }
}

void edit_sound_reader_close(void *handle) {
    @autoreleasepool { EditSoundReader *r = (__bridge_transfer EditSoundReader *)handle; (void)r; }
}

// AAC in an .m4a through AudioToolbox, from 48 kHz stereo float.
@interface EditSoundWriter : NSObject
@property AVAssetWriter *writer;
@property AVAssetWriterInput *input;
@property(nonatomic) CMAudioFormatDescriptionRef format;
@property int64_t written;
@end
@implementation EditSoundWriter
- (void)dealloc {
    if (_writer.status == AVAssetWriterStatusWriting) [_writer cancelWriting];
    if (_format) CFRelease(_format);
}
@end

void *edit_sound_writer_open(const char *path, uint32_t bitrate, char *error, size_t capacity) {
    @autoreleasepool {
        EditSoundWriter *w = [EditSoundWriter new];
        NSError *problem = nil;
        NSURL *url = [NSURL fileURLWithPath:@(path)];
        [[NSFileManager defaultManager] removeItemAtURL:url error:nil];
        w.writer = [[AVAssetWriter alloc] initWithURL:url fileType:AVFileTypeAppleM4A error:&problem];
        if (!w.writer) { fail(error, capacity, problem.localizedDescription ?: @"Native sound encoder unavailable"); return NULL; }
        AudioChannelLayout layout = {0};
        layout.mChannelLayoutTag = kAudioChannelLayoutTag_Stereo;
        w.input = [AVAssetWriterInput assetWriterInputWithMediaType:AVMediaTypeAudio outputSettings:@{
            AVFormatIDKey: @(kAudioFormatMPEG4AAC), AVSampleRateKey: @48000, AVNumberOfChannelsKey: @2,
            AVEncoderBitRateKey: @(bitrate),
            AVChannelLayoutKey: [NSData dataWithBytes:&layout length:sizeof(layout)]}];
        w.input.expectsMediaDataInRealTime = NO;
        if (![w.writer canAddInput:w.input]) { fail(error, capacity, @"Native sound encoder unavailable"); return NULL; }
        [w.writer addInput:w.input];
        AudioStreamBasicDescription pcm = {0};
        pcm.mSampleRate = 48000;
        pcm.mFormatID = kAudioFormatLinearPCM;
        pcm.mFormatFlags = kAudioFormatFlagIsFloat | kAudioFormatFlagIsPacked;
        pcm.mBytesPerPacket = 8; pcm.mFramesPerPacket = 1; pcm.mBytesPerFrame = 8;
        pcm.mChannelsPerFrame = 2; pcm.mBitsPerChannel = 32;
        CMAudioFormatDescriptionRef format = NULL;
        if (CMAudioFormatDescriptionCreate(NULL, &pcm, sizeof(layout), &layout, 0, NULL, NULL, &format) != noErr) {
            fail(error, capacity, @"Cannot describe the sound"); return NULL;
        }
        w.format = format;
        if (![w.writer startWriting]) { fail(error, capacity, w.writer.error.localizedDescription); return NULL; }
        [w.writer startSessionAtSourceTime:kCMTimeZero];
        return (__bridge_retained void *)w;
    }
}

int edit_sound_writer_write(void *handle, const float *samples, size_t frames, char *error, size_t capacity) {
    @autoreleasepool {
        EditSoundWriter *w = (__bridge EditSoundWriter *)handle;
        // A second at a time: bounded buffers and the writer's readiness obeyed.
        for (size_t done = 0; done < frames;) {
            size_t n = MIN((size_t)48000, frames - done);
            NSDate *deadline = [NSDate dateWithTimeIntervalSinceNow:30];
            while (!w.input.readyForMoreMediaData) {
                if (w.writer.status != AVAssetWriterStatusWriting || deadline.timeIntervalSinceNow < 0) {
                    fail(error, capacity, w.writer.error.localizedDescription ?: @"Native sound encoder stalled"); return 0;
                }
                [NSThread sleepForTimeInterval:0.001];
            }
            CMBlockBufferRef block = NULL;
            size_t bytes = n * 2 * sizeof(float);
            if (CMBlockBufferCreateWithMemoryBlock(NULL, NULL, bytes, NULL, NULL, 0, bytes, kCMBlockBufferAssureMemoryNowFlag, &block) != kCMBlockBufferNoErr
                || CMBlockBufferReplaceDataBytes(samples + done * 2, block, 0, bytes) != kCMBlockBufferNoErr) {
                if (block) CFRelease(block);
                fail(error, capacity, @"Cannot buffer the sound"); return 0;
            }
            CMSampleBufferRef sample = NULL;
            OSStatus made = CMAudioSampleBufferCreateReadyWithPacketDescriptions(NULL, block, w.format, (CMItemCount)n,
                CMTimeMake(w.written, 48000), NULL, &sample);
            CFRelease(block);
            if (made != noErr || !sample) { fail(error, capacity, @"Cannot wrap the sound"); return 0; }
            BOOL ok = [w.input appendSampleBuffer:sample];
            CFRelease(sample);
            if (!ok) { fail(error, capacity, w.writer.error.localizedDescription ?: @"Native sound encoder rejected samples"); return 0; }
            w.written += n;
            done += n;
        }
        return 1;
    }
}

int edit_sound_writer_finish(void *handle, char *error, size_t capacity) {
    @autoreleasepool {
        EditSoundWriter *w = (__bridge EditSoundWriter *)handle;
        [w.input markAsFinished];
        dispatch_semaphore_t done = dispatch_semaphore_create(0);
        [w.writer finishWritingWithCompletionHandler:^{ dispatch_semaphore_signal(done); }];
        if (dispatch_semaphore_wait(done, dispatch_time(DISPATCH_TIME_NOW, 60 * NSEC_PER_SEC))) {
            [w.writer cancelWriting]; fail(error, capacity, @"Native sound encoder finish timed out"); return 0;
        }
        if (w.writer.status != AVAssetWriterStatusCompleted) { fail(error, capacity, w.writer.error.localizedDescription); return 0; }
        return 1;
    }
}

void edit_sound_writer_close(void *handle) {
    @autoreleasepool { EditSoundWriter *w = (__bridge_transfer EditSoundWriter *)handle; (void)w; }
}

// ---------------------------------------------------------------------------

@interface EditWriter : NSObject
@property AVAssetWriter *writer;
@property AVAssetWriterInput *input;
@property AVAssetWriterInputPixelBufferAdaptor *adaptor;
@property uint32_t width;
@property uint32_t height;
@property double fps;
@end
@implementation EditWriter
- (void)dealloc { if (_writer.status == AVAssetWriterStatusWriting) [_writer cancelWriting]; }
@end

// `flags`: 1 = a finished export (B-frames, High profile), 2 = move the index
// to the front (only when nothing rewrites the file afterwards).
void *edit_writer_open(const char *path, uint32_t width, uint32_t height, double fps,
                       int hevc, uint64_t bitrate, int key_interval, int flags,
                       char *error, size_t capacity) {
    @autoreleasepool {
        EditWriter *w = [EditWriter new];
        NSError *problem = nil;
        NSURL *url = [NSURL fileURLWithPath:@(path)];
        // AVAssetWriter refuses to replace a file: a stale partial one from an
        // interrupted run would otherwise send every later attempt to FFmpeg.
        [[NSFileManager defaultManager] removeItemAtURL:url error:nil];
        w.writer = [[AVAssetWriter alloc] initWithURL:url fileType:AVFileTypeMPEG4 error:&problem];
        w.writer.movieTimeScale = 600000;
        w.width = width; w.height = height; w.fps = fps;
        NSMutableDictionary *compression = [@{
            AVVideoAverageBitRateKey: @(bitrate), AVVideoExpectedSourceFrameRateKey: @(fps),
            AVVideoMaxKeyFrameIntervalKey: @(key_interval),
            // Previews decode each frame as it arrives; finished files can reorder.
            AVVideoAllowFrameReorderingKey: @((flags & 1) != 0)} mutableCopy];
        if ((flags & 1) && !hevc) compression[AVVideoProfileLevelKey] = AVVideoProfileLevelH264HighAutoLevel;
        w.input = [AVAssetWriterInput assetWriterInputWithMediaType:AVMediaTypeVideo outputSettings:@{
            AVVideoCodecKey: hevc ? AVVideoCodecTypeHEVC : AVVideoCodecTypeH264,
            AVVideoWidthKey: @(width), AVVideoHeightKey: @(height),
            AVVideoColorPropertiesKey: @{
                AVVideoColorPrimariesKey: AVVideoColorPrimaries_ITU_R_709_2,
                AVVideoTransferFunctionKey: AVVideoTransferFunction_ITU_R_709_2,
                AVVideoYCbCrMatrixKey: AVVideoYCbCrMatrix_ITU_R_709_2},
            AVVideoCompressionPropertiesKey: compression
        }];
        w.input.expectsMediaDataInRealTime = NO;
        w.input.mediaTimeScale = 600000;
        w.adaptor = [AVAssetWriterInputPixelBufferAdaptor assetWriterInputPixelBufferAdaptorWithAssetWriterInput:w.input
            sourcePixelBufferAttributes:@{
                (id)kCVPixelBufferPixelFormatTypeKey: @(kCVPixelFormatType_32BGRA),
                (id)kCVPixelBufferWidthKey: @(width), (id)kCVPixelBufferHeightKey: @(height),
                (id)kCVPixelBufferIOSurfacePropertiesKey: @{}
            }];
        if (!w.writer || ![w.writer canAddInput:w.input]) {
            fail(error, capacity, problem.localizedDescription ?: @"Native encoder unavailable"); return NULL;
        }
        [w.writer addInput:w.input];
        w.writer.shouldOptimizeForNetworkUse = (flags & 2) != 0;
        if (![w.writer startWriting]) { fail(error, capacity, w.writer.error.localizedDescription); return NULL; }
        [w.writer startSessionAtSourceTime:kCMTimeZero];
        return (__bridge_retained void *)w;
    }
}

// Appends one picture: `pixels` rows are `stride` bytes apart, RGBA (`rgba`)
// or BGRA. The copy into the encoder's buffer also drops any row padding.
int edit_writer_frame(void *handle, int64_t frame, const uint8_t *pixels, size_t length,
                      size_t stride, int rgba, char *error, size_t capacity) {
    @autoreleasepool {
        EditWriter *w = (__bridge EditWriter *)handle;
        if (stride < (size_t)w.width * 4 || length < stride * (w.height - 1) + (size_t)w.width * 4) return 0;
        // Bound both the encoder's queue and the pixel-buffer pool. Offline writers
        // must obey readiness, otherwise a long export buffers the entire movie.
        NSDate *deadline = [NSDate dateWithTimeIntervalSinceNow:30];
        CVPixelBufferRef pixel = NULL;
        while (!pixel) {
            if (w.writer.status != AVAssetWriterStatusWriting || deadline.timeIntervalSinceNow < 0) {
                fail(error, capacity, w.writer.error.localizedDescription ?: @"Native encoder stalled"); return 0;
            }
            if (w.input.readyForMoreMediaData) {
                CVReturn result = CVPixelBufferPoolCreatePixelBufferWithAuxAttributes(kCFAllocatorDefault,
                    w.adaptor.pixelBufferPool, (__bridge CFDictionaryRef)@{(id)kCVPixelBufferPoolAllocationThresholdKey: @6}, &pixel);
                if (result != kCVReturnSuccess && result != kCVReturnWouldExceedAllocationThreshold) {
                    fail(error, capacity, @"Cannot allocate native encoder pixel buffer"); return 0;
                }
            }
            if (!pixel) [NSThread sleepForTimeInterval:0.001];
        }
        CVReturn locked = CVPixelBufferLockBaseAddress(pixel, 0);
        if (locked != kCVReturnSuccess) { CFRelease(pixel); fail(error, capacity, @"Cannot lock encoder pixel buffer"); return 0; }
        vImage_Buffer source = {(void *)pixels, w.height, w.width, stride};
        vImage_Buffer dest = {CVPixelBufferGetBaseAddress(pixel), w.height, w.width, CVPixelBufferGetBytesPerRow(pixel)};
        vImage_Error converted = kvImageNoError;
        if (rgba) {
            const uint8_t channels[4] = {2, 1, 0, 3};
            converted = vImagePermuteChannels_ARGB8888(&source, &dest, channels, kvImageNoFlags);
        } else {
            for (size_t y = 0; y < w.height; y++) {
                memcpy((uint8_t *)dest.data + y * dest.rowBytes, pixels + y * stride, (size_t)w.width * 4);
            }
        }
        CVPixelBufferUnlockBaseAddress(pixel, 0);
        BOOL ok = converted == kvImageNoError && [w.adaptor appendPixelBuffer:pixel withPresentationTime:CMTimeMakeWithSeconds(frame / w.fps, 600000)];
        CFRelease(pixel);
        if (!ok) fail(error, capacity, w.writer.error.localizedDescription ?: @"Native encoder rejected frame");
        return ok;
    }
}

int edit_writer_finish(void *handle, int64_t frames, char *error, size_t capacity) {
    @autoreleasepool {
        EditWriter *w = (__bridge EditWriter *)handle;
        [w.writer endSessionAtSourceTime:CMTimeMakeWithSeconds(frames / w.fps, 600000)];
        [w.input markAsFinished];
        dispatch_semaphore_t done = dispatch_semaphore_create(0);
        [w.writer finishWritingWithCompletionHandler:^{ dispatch_semaphore_signal(done); }];
        if (dispatch_semaphore_wait(done, dispatch_time(DISPATCH_TIME_NOW, 60 * NSEC_PER_SEC))) {
            [w.writer cancelWriting]; fail(error, capacity, @"Native encoder finish timed out"); return 0;
        }
        if (w.writer.status != AVAssetWriterStatusCompleted) { fail(error, capacity, w.writer.error.localizedDescription); return 0; }
        return 1;
    }
}

void edit_writer_close(void *handle) {
    @autoreleasepool { EditWriter *w = (__bridge_transfer EditWriter *)handle; (void)w; }
}
