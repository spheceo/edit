// edit-speech: words heard on this Mac by Apple's SpeechAnalyzer and
// SpeechTranscriber (macOS 26), for apps/server/src/mac_speech.ts. Free, on
// device, ~45-50x real time on an M1, with no drift over hours; no speakers
// and no custom vocabulary (SpeechTranscriber ignores contextualStrings), so
// Edit uses it for the rough first hearing and pays Scribe only for what a
// script or subtitles keep.
//
//   edit-speech <audio or video> [--ffmpeg <path>]
//
// Writes {"words":[{"text","start","end"}],"language":"en-US","ms":<wall>,
// "model":"apple-speech","seconds":<the sound's length>} to stdout, times in
// seconds, one word per entry in order.
// Progress goes to stderr; a failure exits non-zero with one line saying why.
// The file is read by AVAudioFile (a video's first sound track too); one it
// can't read is turned into a 16 kHz mono WAV by FFmpeg first.
//
// Built by scripts/build-speech.sh (`just speech`; a dev run builds it on
// demand), shipped beside edit / in Edit.app's Resources as edit-speech.

@preconcurrency import AVFoundation
import CoreMedia
import Foundation
import Speech

func say(_ line: String) { FileHandle.standardError.write((line + "\n").data(using: .utf8)!) }

func fail(_ reason: String) -> Never {
  say(reason.replacingOccurrences(of: "\n", with: " "))
  exit(1)
}

struct Word: Encodable { let text: String; let start: Double; let end: Double }
struct Out: Encodable { let words: [Word]; let language: String; let ms: Int; let model: String; let seconds: Double }

@main
struct Main {
  static func main() async {
    var args = Array(CommandLine.arguments.dropFirst())
    var ffmpeg = "ffmpeg"
    if let at = args.firstIndex(of: "--ffmpeg"), at + 1 < args.count {
      ffmpeg = args[at + 1]
      args.removeSubrange(at...at + 1)
    }
    guard args.count == 1 else { say("usage: edit-speech <audio or video> [--ffmpeg <path>]"); exit(2) }
    guard #available(macOS 26, *) else { fail("on-device speech needs macOS 26 or later") }
    do {
      try await hear(URL(fileURLWithPath: args[0]), ffmpeg: ffmpeg)
    } catch let error as Reason {
      fail(error.text)
    } catch {
      fail("speech failed: \(error.localizedDescription)")
    }
  }
}

struct Reason: Error { let text: String }

@available(macOS 26, *)
func hear(_ input: URL, ffmpeg: String) async throws {
  let started = Date()
  guard FileManager.default.isReadableFile(atPath: input.path) else { throw Reason(text: "can't read \(input.path)") }
  guard SpeechTranscriber.isAvailable else { throw Reason(text: "on-device speech isn't available on this Mac") }
  let locale = Locale(identifier: "en-US")
  guard let supported = await SpeechTranscriber.supportedLocale(equivalentTo: locale) else {
    throw Reason(text: "on-device speech doesn't hear en-US on this Mac")
  }
  let transcriber = SpeechTranscriber(locale: supported, transcriptionOptions: [], reportingOptions: [], attributeOptions: [.audioTimeRange])
  try await install(transcriber)

  var temporary: URL? = nil
  defer { if let temporary { try? FileManager.default.removeItem(at: temporary) } }
  let opened: AVAudioFile? = try? AVAudioFile(forReading: input)
  let file: AVAudioFile
  if let opened, opened.length > 0 {
    file = opened
  } else {
    say("speech: AVAudioFile can't read it; extracting the sound with FFmpeg")
    let wav = FileManager.default.temporaryDirectory.appendingPathComponent("edit-speech-\(UUID().uuidString).wav")
    temporary = wav
    try extract(input, to: wav, ffmpeg: ffmpeg)
    do { file = try AVAudioFile(forReading: wav) } catch { throw Reason(text: "can't read the sound of \(input.lastPathComponent): \(error.localizedDescription)") }
  }
  let fileFormat = file.processingFormat
  guard let format = await SpeechAnalyzer.bestAvailableAudioFormat(compatibleWith: [transcriber], considering: fileFormat) else {
    throw Reason(text: "no audio format the speech model takes")
  }
  guard let converter = AVAudioConverter(from: fileFormat, to: format) else { throw Reason(text: "can't convert \(fileFormat) to \(format)") }
  let seconds = Double(file.length) / fileFormat.sampleRate

  let analyzer = SpeechAnalyzer(modules: [transcriber])
  try await analyzer.prepareToAnalyze(in: format)

  // Final results only (no reportingOptions), each run one word with its time.
  let collector = Task { () throws -> [Word] in
    var words: [Word] = []
    for try await result in transcriber.results {
      for run in result.text.runs {
        guard let range = run.audioTimeRange else { continue }
        let text = String(result.text[run.range].characters).trimmingCharacters(in: .whitespacesAndNewlines)
        if text.isEmpty { continue }
        let start = range.start.seconds, end = range.end.seconds
        // A run has always been one word; should one ever hold several, they share its time evenly.
        let parts = text.split(whereSeparator: \.isWhitespace).map(String.init)
        let step = (end - start) / Double(parts.count)
        for (index, part) in parts.enumerated() {
          words.append(Word(text: part, start: start + step * Double(index), end: start + step * Double(index + 1)))
        }
      }
    }
    return words
  }

  // The file in ~1 s buffers, converted to the analyzer's format.
  let (stream, feed) = AsyncStream<AnalyzerInput>.makeStream()
  let feeder = Task { () throws in
    defer { feed.finish() }
    let chunk = AVAudioFrameCount(fileFormat.sampleRate)
    var reported = -1
    while file.framePosition < file.length {
      guard let buffer = AVAudioPCMBuffer(pcmFormat: fileFormat, frameCapacity: chunk) else { throw Reason(text: "out of memory") }
      try file.read(into: buffer, frameCount: chunk)
      if buffer.frameLength == 0 { break }
      let capacity = AVAudioFrameCount(Double(buffer.frameLength) * format.sampleRate / fileFormat.sampleRate) + 64
      guard let out = AVAudioPCMBuffer(pcmFormat: format, frameCapacity: capacity) else { throw Reason(text: "out of memory") }
      var given = false
      var failure: NSError?
      converter.convert(to: out, error: &failure) { _, status in
        if given { status.pointee = .noDataNow; return nil }
        given = true
        status.pointee = .haveData
        return buffer
      }
      if let failure { throw Reason(text: "can't convert the sound: \(failure.localizedDescription)") }
      if out.frameLength > 0 { feed.yield(AnalyzerInput(buffer: out)) }
      let tenth = Int(Double(file.framePosition) / Double(file.length) * 10)
      if tenth != reported { reported = tenth; say("speech: read \(tenth * 10)%") }
    }
  }

  let last = try await analyzer.analyzeSequence(stream)
  do { try await feeder.value } catch { await analyzer.cancelAndFinishNow(); collector.cancel(); throw error }
  if let last { try await analyzer.finalizeAndFinish(through: last) } else { await analyzer.cancelAndFinishNow() }
  let words = try await collector.value
  let ms = Int(Date().timeIntervalSince(started) * 1000)
  say("speech: \(words.count) words in \(Int(seconds)) s of sound, \(ms) ms")
  let encoder = JSONEncoder()
  encoder.outputFormatting = [.withoutEscapingSlashes]
  let json = try encoder.encode(Out(words: words, language: supported.identifier(.bcp47), ms: ms, model: "apple-speech", seconds: seconds))
  FileHandle.standardOutput.write(json)
  FileHandle.standardOutput.write("\n".data(using: .utf8)!)
}

/// The en-US model, downloaded once (AssetInventory keeps it for every app).
@available(macOS 26, *)
func install(_ transcriber: SpeechTranscriber) async throws {
  if await AssetInventory.status(forModules: [transcriber]) == .installed { return }
  guard let request = try await AssetInventory.assetInstallationRequest(supporting: [transcriber]) else {
    if await AssetInventory.status(forModules: [transcriber]) == .installed { return }
    throw Reason(text: "the en-US speech model isn't on this Mac and can't be downloaded")
  }
  say("speech: downloading the en-US model")
  let progress = request.progress
  let watcher = Task {
    var shown = -1
    while !Task.isCancelled {
      let percent = Int(progress.fractionCompleted * 100)
      if percent != shown { shown = percent; say("speech: model \(percent)%") }
      try? await Task.sleep(for: .seconds(1))
    }
  }
  defer { watcher.cancel() }
  do { try await request.downloadAndInstall() } catch { throw Reason(text: "the en-US speech model didn't download: \(error.localizedDescription)") }
  guard await AssetInventory.status(forModules: [transcriber]) == .installed else { throw Reason(text: "the en-US speech model didn't install") }
  say("speech: model installed")
}

/// The sound as a 16 kHz mono WAV, for a file AVAudioFile can't open.
func extract(_ input: URL, to wav: URL, ffmpeg: String) throws {
  let process = Process()
  process.executableURL = URL(fileURLWithPath: ffmpeg.contains("/") ? ffmpeg : "/usr/bin/env")
  let tail = ["-hide_banner", "-v", "error", "-nostdin", "-y", "-i", input.path, "-vn", "-ac", "1", "-ar", "16000", "-c:a", "pcm_s16le", wav.path]
  process.arguments = ffmpeg.contains("/") ? tail : [ffmpeg] + tail
  let errors = Pipe()
  process.standardError = errors
  process.standardOutput = FileHandle.nullDevice
  do { try process.run() } catch { throw Reason(text: "can't run FFmpeg (\(ffmpeg)): \(error.localizedDescription)") }
  let said = errors.fileHandleForReading.readDataToEndOfFile()
  process.waitUntilExit()
  guard process.terminationStatus == 0 else {
    let line = String(decoding: said, as: UTF8.self).split(separator: "\n").last.map(String.init) ?? "exit \(process.terminationStatus)"
    throw Reason(text: "can't read \(input.lastPathComponent): \(line)")
  }
}
