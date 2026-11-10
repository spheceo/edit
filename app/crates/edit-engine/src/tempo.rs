//! Playing at a speed (docs/plans/2026-11-10-script-player.md, step 4): what
//! Edit.app's player (`crate::player`) needs to play at 2× with the sound's
//! pitch kept, apart from the Mac so every machine's tests run it.
//!
//! The mixer still mixes the timeline as it is (`mix::mix_live`); `Tempo`
//! then makes each window shorter or longer on its way to the speaker. It's
//! WSOLA, the method a browser plays a sped-up video's sound with: the sound
//! goes out as 20 ms blocks laid half over each other, each faded into the
//! next, and a block is taken from where the speed says the sound should be
//! by now, give or take 15 ms, at the place most like what the block before
//! would have gone on to. So a voice's waves join where they line up, and
//! nothing is resampled: the pitch stays. Where the next block is simply the
//! sound going on (it's inside those 15 ms), it's taken as it is, and the
//! sound between is the footage's own, sample for sample.
//!
//! `Clock` is the playhead's arithmetic at a speed, `stride` and `missed`
//! the picture's: at 2× every other frame is drawn, by design.

use crate::mix::RATE;

/// The speeds the player takes.
pub const SLOWEST: f64 = 0.25;
pub const FASTEST: f64 = 4.0;

/// A speed the player takes: `rate` held within 0.25–4 (1 for a number that isn't one).
pub fn speed(rate: f64) -> f64 {
    if rate.is_finite() {
        rate.clamp(SLOWEST, FASTEST)
    } else {
        1.0
    }
}

/// The playhead by the speaker's count. The sound the speaker plays from the
/// clock's start on is the timeline from `from` seconds at `rate`; what it
/// was still playing just before is at `lead` (the speed before a change
/// while playing; 0 holds the playhead at `from` until its own sound is
/// heard, as a play from rest does).
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct Clock {
    pub from: f64,
    pub rate: f64,
    pub lead: f64,
}

impl Clock {
    /// The timeline's seconds once `heard` seconds of the clock's sound have
    /// been heard (under 0: the sound before it is still coming out).
    pub fn at(&self, heard: f64) -> f64 {
        self.from + heard * if heard >= 0.0 { self.rate } else { self.lead }
    }

    /// The speed the playhead moves at then (the clock's own while it holds).
    pub fn speed(&self, heard: f64) -> f64 {
        if heard >= 0.0 || self.lead <= 0.0 {
            self.rate
        } else {
            self.lead
        }
    }
}

/// How many frames on the next picture is at `rate`: playing draws no more
/// pictures a second than the edit has, so 2× shows every other frame.
pub fn stride(rate: f64) -> i64 {
    (rate.round() as i64).max(1)
}

/// Pictures the player failed to draw between frame `drawn` and `frame`: the
/// ones a speed passes by design aren't counted.
pub fn missed(drawn: i64, frame: i64, stride: i64) -> u64 {
    ((frame - drawn) / stride.max(1) - 1).max(0) as u64
}

/// A block of sound (frames), half of it laid over the block before.
const BLOCK: usize = RATE / 50;
const HOP: usize = BLOCK / 2;
/// How far either side of where the speed says a block is taken from it may be taken (frames).
const REACH: usize = RATE * 15 / 1000;
/// The first look for a block tries every fourth place, on every other sample.
const COARSE: usize = 4;
/// Sound already passed is let go of once there's this much of it (frames).
const PASSED: usize = 1 << 14;

/// 48 kHz stereo made `rate` times as fast, its pitch kept: `push` the sound
/// in as it comes (interleaved, any amount at a time), take what comes out,
/// `flush` at its end. At 1× the sound goes through untouched.
pub struct Tempo {
    rate: f64,
    /// The sound still needed (interleaved stereo) and the same as one channel, from frame `base` of all pushed.
    held: Vec<f32>,
    mono: Vec<f32>,
    base: usize,
    pushed: usize,
    /// Blocks laid, and where in the sound the last one was taken from.
    blocks: usize,
    last: usize,
    /// The last block's second half, faded out, for the next to be laid over.
    tail: Vec<f32>,
    /// A block's fade in over its first half (a Hann window's rise), a value per sample.
    rise: Vec<f32>,
    emitted: usize,
}

impl Tempo {
    pub fn new(rate: f64) -> Self {
        let rise = (0..HOP * 2)
            .map(|sample| {
                let frame = (sample / 2) as f32;
                0.5 - 0.5 * (std::f32::consts::PI * frame / HOP as f32).cos()
            })
            .collect();
        Self {
            rate: speed(rate),
            held: Vec::new(),
            mono: Vec::new(),
            base: 0,
            pushed: 0,
            blocks: 0,
            last: 0,
            tail: vec![0.0; HOP * 2],
            rise,
            emitted: 0,
        }
    }

    pub fn rate(&self) -> f64 {
        self.rate
    }

    fn untouched(&self) -> bool {
        (self.rate - 1.0).abs() < 1e-9
    }

    /// More of the sound; what's ready of it at the new speed is added to `out`.
    pub fn push(&mut self, input: &[f32], out: &mut Vec<f32>) {
        if self.untouched() {
            out.extend_from_slice(input);
            return;
        }
        let frames = input.as_chunks::<2>().0;
        self.held.extend_from_slice(frames.as_flattened());
        self.mono
            .extend(frames.iter().map(|[left, right]| (left + right) * 0.5));
        self.pushed += frames.len();
        // A block is laid only once everything it could be taken from is here, so the sound out
        // is the same however the sound in was cut up.
        while self.pushed >= self.needed() {
            self.lay(out);
        }
    }

    /// The sound's end: the rest goes to `out`, which in all is the sound's length ÷ the speed.
    pub fn flush(&mut self, out: &mut Vec<f32>) {
        if self.untouched() {
            return;
        }
        let want = (self.pushed as f64 / self.rate).round() as usize;
        while self.emitted < want {
            // Past the end is silence.
            let short = self.needed().saturating_sub(self.base + self.mono.len());
            self.held.extend(std::iter::repeat_n(0.0, short * 2));
            self.mono.extend(std::iter::repeat_n(0.0, short));
            self.lay(out);
        }
        let over = self.emitted.saturating_sub(want);
        out.truncate(out.len().saturating_sub(over * 2));
        self.emitted = want;
    }

    /// Where the speed says the next block is taken from, and where the sound of the last one goes on.
    fn next(&self) -> (usize, usize) {
        if self.blocks == 0 {
            return (0, 0);
        }
        let ideal = ((self.blocks * HOP) as f64 * self.rate).round() as usize;
        (ideal, self.last + HOP)
    }

    /// How much of the sound has to be in before the next block can be laid (frames in all).
    fn needed(&self) -> usize {
        let (ideal, goes_on) = self.next();
        let reach = if self.blocks == 0 { 0 } else { REACH };
        // Never more out than the sound in makes at this speed (a flush only adds).
        let paced = (((self.blocks + 1) * HOP) as f64 * self.rate).ceil() as usize;
        ((ideal + reach).max(goes_on) + BLOCK).max(paced)
    }

    /// Lays the next block: half a block more of sound out.
    fn lay(&mut self, out: &mut Vec<f32>) {
        let (ideal, goes_on) = self.next();
        let (low, high) = (ideal.saturating_sub(REACH), ideal + REACH);
        let chosen = if self.blocks == 0 || (low..=high).contains(&goes_on) {
            goes_on
        } else {
            self.most_alike(goes_on, low, high, ideal)
        };
        let at = chosen.saturating_sub(self.base) * 2;
        let block = self.held.get(at..at + BLOCK * 2).unwrap_or_default();
        let (first, second) = block.split_at(block.len().min(HOP * 2));
        if self.blocks == 0 {
            out.extend_from_slice(first);
        } else {
            out.extend(
                first
                    .iter()
                    .zip(&self.tail)
                    .zip(&self.rise)
                    .map(|((sample, tail), rise)| tail + sample * rise),
            );
        }
        for ((tail, sample), rise) in self.tail.iter_mut().zip(second).zip(&self.rise) {
            *tail = sample * (1.0 - rise);
        }
        self.last = chosen;
        self.blocks += 1;
        self.emitted += HOP;
        // What no later block can be taken from is let go of, a good stretch at a time.
        let (ideal, goes_on) = self.next();
        let keep = goes_on.min(ideal.saturating_sub(REACH));
        if keep >= self.base + PASSED {
            let passed = keep - self.base;
            self.held.drain(..passed * 2);
            self.mono.drain(..passed);
            self.base = keep;
        }
    }

    /// The place within `low..=high` whose block is most like the one at
    /// `goes_on` (the sound the last block would have gone on to): the
    /// highest correlation for its loudness. Silence there: `ideal`.
    fn most_alike(&self, goes_on: usize, low: usize, high: usize, ideal: usize) -> usize {
        let block = |from: usize| {
            let at = from.saturating_sub(self.base);
            self.mono.get(at..at + BLOCK).unwrap_or_default()
        };
        let wanted = block(goes_on);
        if wanted.iter().map(|sample| sample * sample).sum::<f32>() < 1e-9 {
            return ideal;
        }
        let alike = |from: usize, step: usize| {
            let (mut both, mut own) = (0.0_f32, 0.0_f32);
            for (a, b) in wanted
                .iter()
                .step_by(step)
                .zip(block(from).iter().step_by(step))
            {
                both += a * b;
                own += b * b;
            }
            both / (own + 1e-9).sqrt()
        };
        let best = |places: &mut dyn Iterator<Item = usize>, step: usize, otherwise: usize| {
            places
                .map(|from| (from, alike(from, step)))
                .fold((otherwise, f32::MIN), |best, next| {
                    if next.1 > best.1 {
                        next
                    } else {
                        best
                    }
                })
                .0
        };
        let near = best(&mut (low..=high).step_by(COARSE), 2, ideal);
        let around = near.saturating_sub(COARSE - 1).max(low)..=(near + COARSE - 1).min(high);
        best(&mut around.into_iter(), 1, near)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// `seconds` of a sine at `hz`, the same in both channels.
    fn sine(hz: f64, seconds: f64, level: f32) -> Vec<f32> {
        (0..(seconds * RATE as f64) as usize)
            .flat_map(|frame| {
                let value =
                    (std::f64::consts::TAU * hz * frame as f64 / RATE as f64).sin() as f32 * level;
                [value, value]
            })
            .collect()
    }

    /// A voice-like sound: a 130 Hz buzz with its overtones, louder and softer four times a second.
    fn voice(seconds: f64) -> Vec<f32> {
        (0..(seconds * RATE as f64) as usize)
            .flat_map(|frame| {
                let t = frame as f64 / RATE as f64;
                let swell = 0.6 + 0.4 * (std::f64::consts::TAU * 4.0 * t).sin();
                let value: f64 = (1..=12)
                    .map(|n| (std::f64::consts::TAU * 130.0 * n as f64 * t).sin() / n as f64)
                    .sum();
                let value = (value * swell * 0.3) as f32;
                [value, value * 0.8]
            })
            .collect()
    }

    fn stretched(sound: &[f32], rate: f64) -> Vec<f32> {
        let mut tempo = Tempo::new(rate);
        let mut out = Vec::new();
        tempo.push(sound, &mut out);
        tempo.flush(&mut out);
        out
    }

    /// The left channel's pitch by its upward zero crossings, away from the two ends.
    fn pitch(sound: &[f32]) -> f64 {
        let left: Vec<f32> = sound.iter().step_by(2).copied().collect();
        let middle = &left[RATE / 10..left.len() - RATE / 10];
        let crossings: Vec<f64> = middle
            .windows(2)
            .enumerate()
            .filter(|(_, pair)| pair[0] < 0.0 && pair[1] >= 0.0)
            .map(|(at, pair)| at as f64 + f64::from(pair[0] / (pair[0] - pair[1])))
            .collect();
        (crossings.len() - 1) as f64 * RATE as f64 / (crossings[crossings.len() - 1] - crossings[0])
    }

    /// The biggest step from one sample to the next, in either channel.
    fn biggest_step(sound: &[f32]) -> f32 {
        sound
            .windows(3)
            .map(|three| (three[2] - three[0]).abs())
            .fold(0.0, f32::max)
    }

    #[test]
    fn the_sound_out_is_the_sound_in_divided_by_the_speed() {
        let sound = voice(3.0);
        for rate in [0.25, 0.5, 0.75, 1.25, 1.5, 2.0, 3.0, 4.0] {
            let out = stretched(&sound, rate);
            assert_eq!(
                out.len() / 2,
                (sound.len() as f64 / 2.0 / rate).round() as usize,
                "at {rate}×"
            );
        }
        // An odd length, and a sound shorter than a block.
        assert_eq!(stretched(&sound[..2 * 100_001], 2.0).len() / 2, 50_001);
        assert_eq!(stretched(&sound[..2 * 300], 2.0).len() / 2, 150);
        assert_eq!(stretched(&[], 2.0).len(), 0);
    }

    #[test]
    fn a_tone_keeps_its_pitch_twice_as_fast_and_half_as_fast() {
        let sound = sine(440.0, 2.0, 0.5);
        for rate in [2.0, 0.5, 1.5, 4.0] {
            let heard = pitch(&stretched(&sound, rate));
            assert!((heard - 440.0).abs() < 1.0, "{heard} Hz at {rate}×");
        }
    }

    #[test]
    fn a_smooth_sound_has_no_clicks_where_its_blocks_join() {
        for (name, sound) in [("a tone", sine(220.0, 2.0, 0.5)), ("a voice", voice(2.0))] {
            let before = biggest_step(&sound);
            for rate in [2.0, 0.5, 1.5] {
                let after = biggest_step(&stretched(&sound, rate));
                assert!(
                    after <= before * 1.25,
                    "{name} at {rate}×: a step of {after}, the sound's own biggest is {before}"
                );
            }
        }
    }

    #[test]
    fn a_tone_stays_as_loud() {
        let sound = sine(440.0, 2.0, 0.5);
        let rms = |sound: &[f32]| {
            (sound.iter().map(|x| f64::from(x * x)).sum::<f64>() / sound.len() as f64).sqrt()
        };
        for rate in [2.0, 0.5] {
            let out = stretched(&sound, rate);
            let ratio = rms(&out[RATE / 5..out.len() - RATE / 5]) / rms(&sound);
            assert!(
                (ratio - 1.0).abs() < 0.02,
                "{ratio} of its level at {rate}×"
            );
        }
    }

    #[test]
    fn at_one_the_sound_goes_through_untouched() {
        let sound = voice(1.0);
        assert_eq!(stretched(&sound, 1.0), sound);
        let mut tempo = Tempo::new(1.0);
        let mut out = Vec::new();
        for piece in sound.chunks(2 * 441) {
            tempo.push(piece, &mut out);
        }
        tempo.flush(&mut out);
        assert_eq!(out, sound);
    }

    #[test]
    fn small_pushes_make_the_same_sound_as_one() {
        let sound = voice(3.0);
        for rate in [2.0, 0.5, 1.5] {
            let whole = stretched(&sound, rate);
            for frames in [1, 441, 12_000, 40_000] {
                let mut tempo = Tempo::new(rate);
                let mut out = Vec::new();
                for piece in sound.chunks(2 * frames) {
                    tempo.push(piece, &mut out);
                }
                tempo.flush(&mut out);
                assert!(out == whole, "{frames} frames a push at {rate}×");
            }
        }
    }

    #[test]
    fn a_speed_is_held_within_what_the_player_takes() {
        assert_eq!(speed(2.0), 2.0);
        assert_eq!(speed(0.1), 0.25);
        assert_eq!(speed(9.0), 4.0);
        assert_eq!(speed(f64::NAN), 1.0);
        assert_eq!(Tempo::new(100.0).rate(), 4.0);
    }

    #[test]
    fn the_clock_runs_at_the_speed_from_where_it_started() {
        let clock = Clock {
            from: 10.0,
            rate: 2.0,
            lead: 0.0,
        };
        // Its own sound not heard yet (the speaker's latency): the playhead holds.
        assert_eq!(clock.at(-0.02), 10.0);
        assert_eq!(clock.at(0.0), 10.0);
        assert_eq!(clock.at(1.5), 13.0);
        // A change of speed while playing: what's still coming out is at the speed before, so the
        // playhead runs on through the change with no jump.
        let changed = Clock {
            from: 13.0,
            rate: 1.0,
            lead: 2.0,
        };
        assert_eq!(changed.at(-0.1), 12.8);
        assert_eq!(changed.at(0.0), 13.0);
        assert_eq!(changed.at(0.5), 13.5);
        assert_eq!((changed.speed(-0.1), changed.speed(0.5)), (2.0, 1.0));
        assert_eq!(clock.speed(-0.02), 2.0);
    }

    #[test]
    fn a_speed_passes_frames_by_design_and_only_the_rest_are_missed() {
        assert_eq!(
            (stride(1.0), stride(2.0), stride(0.5), stride(4.0)),
            (1, 2, 1, 4)
        );
        // At 1×: every frame between is one missed.
        assert_eq!(missed(10, 11, 1), 0);
        assert_eq!(missed(10, 13, 1), 2);
        // At 2×: every other frame is the plan; a whole stride more is one missed.
        assert_eq!(missed(10, 12, 2), 0);
        assert_eq!(missed(10, 13, 2), 0);
        assert_eq!(missed(10, 14, 2), 1);
        assert_eq!(missed(10, 10, 2), 0);
    }
}
