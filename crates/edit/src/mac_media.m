// The C boundary owns its objects and drains temporary objects on every frame.
// No decoded-frame array, raw-video pipe, or codec process lives behind it.
#import <AVFoundation/AVFoundation.h>
#import <Accelerate/Accelerate.h>
#import <ImageIO/ImageIO.h>

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

@interface EditReader : NSObject
@property AVURLAsset *asset;
@property AVAssetTrack *track;
@property AVAssetReader *reader;
@property AVAssetReaderTrackOutput *output;
@property(nonatomic) CMSampleBufferRef held;
@property(nonatomic) CMSampleBufferRef next;
@property double requested;
@property uint32_t width;
@property uint32_t height;
@property unsigned rotation;
@property NSMutableData *rotated;
@end

@implementation EditReader
- (void)dealloc {
    [_reader cancelReading];
    if (_held) CFRelease(_held);
    if (_next) CFRelease(_next);
}
- (BOOL)restart:(double)time error:(NSError **)error {
    [_reader cancelReading];
    if (_held) CFRelease(_held);
    if (_next) CFRelease(_next);
    _held = NULL;
    _next = NULL;
    _reader = [[AVAssetReader alloc] initWithAsset:_asset error:error];
    if (!_reader) return NO;
    // Decode at the required size, avoiding a 4K RGBA copy for a 1080p export.
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
    CMTime start = CMTimeMakeWithSeconds(MAX(0, time), 600000);
    _reader.timeRange = CMTimeRangeFromTimeToTime(start, _asset.duration);
    return [_reader startReading];
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

int edit_reader_frame(void *handle, double time, uint8_t *rgba, size_t length,
                      char *error, size_t capacity) {
    @autoreleasepool {
        EditReader *r = (__bridge EditReader *)handle;
        if (length != (size_t)r.width * r.height * 4 || !isfinite(time)) return 0;
        NSError *problem = nil;
        // Start a little before the target to select the frame covering it.
        double step = 1.0 / MAX(1, r.track.nominalFrameRate);
        double duration = CMTimeGetSeconds(r.asset.duration);
        if (!isfinite(duration) || duration <= 0) { fail(error, capacity, @"Native track has no finite duration"); return 0; }
        // An over-trimmed clip holds its last picture. Never pass a negative
        // CMTimeRange duration into AVFoundation (which raises an exception).
        time = MIN(MAX(0, time), MAX(0, duration - step * 0.5));
        if (!r.reader || time < r.requested - 0.000001 || time - r.requested > 2) {
            if (![r restart:MAX(0, time - step) error:&problem]) {
                fail(error, capacity, problem.localizedDescription ?: r.reader.error.localizedDescription);
                return 0;
            }
        }
        r.requested = time;
        if (!r.held) r.held = [r.output copyNextSampleBuffer];
        if (!r.next) r.next = [r.output copyNextSampleBuffer];
        while (r.next && CMTimeGetSeconds(CMSampleBufferGetPresentationTimeStamp(r.next)) <= time + 0.000001) {
            if (r.held) CFRelease(r.held);
            r.held = r.next;
            r.next = [r.output copyNextSampleBuffer];
        }
        if (!r.held || r.reader.status == AVAssetReaderStatusFailed) {
            fail(error, capacity, r.reader.error.localizedDescription ?: @"No native frame at this time");
            return 0;
        }
        CVPixelBufferRef pixel = CMSampleBufferGetImageBuffer(r.held);
        if (!pixel || CVPixelBufferLockBaseAddress(pixel, kCVPixelBufferLock_ReadOnly) != kCVReturnSuccess) {
            fail(error, capacity, @"Cannot lock decoded pixel buffer"); return 0;
        }
        vImage_Buffer source = {CVPixelBufferGetBaseAddress(pixel), CVPixelBufferGetHeight(pixel),
            CVPixelBufferGetWidth(pixel), CVPixelBufferGetBytesPerRow(pixel)};
        vImage_Buffer dest = {rgba, r.height, r.width, r.width * 4};
        vImage_Error result = kvImageNoError;
        if (r.rotation) {
            size_t w = r.rotation % 2 ? source.height : source.width;
            size_t h = r.rotation % 2 ? source.width : source.height;
            if (r.rotated.length != w * h * 4) r.rotated = [NSMutableData dataWithLength:w * h * 4];
            vImage_Buffer rotated = {r.rotated.mutableBytes, h, w, w * 4};
            const uint8_t black[4] = {0, 0, 0, 255};
            result = vImageRotate90_ARGB8888(&source, &rotated, r.rotation, black, kvImageNoFlags);
            source = rotated;
        }
        if (result == kvImageNoError) result = vImageScale_ARGB8888(&source, &dest, NULL, kvImageNoFlags);
        const uint8_t channels[4] = {2, 1, 0, 3};
        if (result == kvImageNoError) result = vImagePermuteChannels_ARGB8888(&dest, &dest, channels, kvImageNoFlags);
        CVPixelBufferUnlockBaseAddress(pixel, kCVPixelBufferLock_ReadOnly);
        if (result != kvImageNoError) { fail(error, capacity, @"Native pixel conversion failed"); return 0; }
        return 1;
    }
}

void edit_reader_close(void *handle) {
    @autoreleasepool { EditReader *r = (__bridge_transfer EditReader *)handle; (void)r; }
}

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

void *edit_writer_open(const char *path, uint32_t width, uint32_t height, double fps,
                       int hevc, uint64_t bitrate, int key_interval, char *error, size_t capacity) {
    @autoreleasepool {
        EditWriter *w = [EditWriter new];
        NSError *problem = nil;
        w.writer = [[AVAssetWriter alloc] initWithURL:[NSURL fileURLWithPath:@(path)] fileType:AVFileTypeMPEG4 error:&problem];
        w.writer.movieTimeScale = 600000;
        w.width = width; w.height = height; w.fps = fps;
        w.input = [AVAssetWriterInput assetWriterInputWithMediaType:AVMediaTypeVideo outputSettings:@{
            AVVideoCodecKey: hevc ? AVVideoCodecTypeHEVC : AVVideoCodecTypeH264,
            AVVideoWidthKey: @(width), AVVideoHeightKey: @(height),
            AVVideoColorPropertiesKey: @{
                AVVideoColorPrimariesKey: AVVideoColorPrimaries_ITU_R_709_2,
                AVVideoTransferFunctionKey: AVVideoTransferFunction_ITU_R_709_2,
                AVVideoYCbCrMatrixKey: AVVideoYCbCrMatrix_ITU_R_709_2},
            AVVideoCompressionPropertiesKey: @{
                AVVideoAverageBitRateKey: @(bitrate), AVVideoExpectedSourceFrameRateKey: @(fps),
                AVVideoMaxKeyFrameIntervalKey: @(key_interval), AVVideoAllowFrameReorderingKey: @NO}
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
        w.writer.shouldOptimizeForNetworkUse = YES;
        if (![w.writer startWriting]) { fail(error, capacity, w.writer.error.localizedDescription); return NULL; }
        [w.writer startSessionAtSourceTime:kCMTimeZero];
        return (__bridge_retained void *)w;
    }
}

int edit_writer_frame(void *handle, int64_t frame, const uint8_t *rgba, size_t length,
                      char *error, size_t capacity) {
    @autoreleasepool {
        EditWriter *w = (__bridge EditWriter *)handle;
        if (length != (size_t)w.width * w.height * 4) return 0;
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
        vImage_Buffer source = {(void *)rgba, w.height, w.width, w.width * 4};
        vImage_Buffer dest = {CVPixelBufferGetBaseAddress(pixel), w.height, w.width, CVPixelBufferGetBytesPerRow(pixel)};
        const uint8_t channels[4] = {2, 1, 0, 3};
        vImage_Error converted = vImagePermuteChannels_ARGB8888(&source, &dest, channels, kvImageNoFlags);
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
