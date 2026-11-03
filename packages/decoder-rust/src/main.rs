use audioadapter_buffers::direct::InterleavedSlice;
use rubato::{Fft, FixedSync, Indexing, Resampler};
use std::{
    env,
    fs::File,
    io::{self, BufWriter, Cursor, Read, Seek, SeekFrom, Write},
    path::Path,
};
use symphonia::core::{
    codecs::{audio::AudioDecoderOptions, registry::CodecRegistry},
    formats::{FormatOptions, TrackType, probe::Hint},
    io::{MediaSource, MediaSourceStream},
    meta::MetadataOptions,
};

fn codecs() -> CodecRegistry {
    let mut codecs = CodecRegistry::new();
    symphonia::default::register_enabled_codecs(&mut codecs);
    codecs.register_audio_decoder::<symphonia_adapter_libopus::OpusDecoder>();
    codecs
}

struct StdinSource {
    prefix: Cursor<Vec<u8>>,
}
impl Read for StdinSource {
    fn read(&mut self, b: &mut [u8]) -> io::Result<usize> {
        let n = self.prefix.read(b)?;
        if n > 0 { Ok(n) } else { io::stdin().read(b) }
    }
}

fn stream_prefix() -> io::Result<(Vec<u8>, bool)> {
    let mut prefix = Vec::new();
    let mut stdin = io::stdin().lock();
    loop {
        if prefix.len() >= 4 {
            let ogg = prefix.starts_with(b"OggS");
            let webm = prefix.starts_with(&[0x1a, 0x45, 0xdf, 0xa3]);
            if ogg || webm {
                if let Some(pos) = prefix.windows(8).position(|w| w == b"OpusHead") {
                    if prefix.len() > pos + 9 {
                        return Ok((prefix.clone(), (1..=2).contains(&prefix[pos + 9])));
                    }
                }
                if prefix.windows(6).any(|w| w == b"vorbis") {
                    return Ok((prefix, false));
                }
            } else if prefix.starts_with(b"ID3") {
                if prefix.len() >= 10 {
                    if prefix[6..10].iter().any(|b| b & 0x80 != 0) {
                        return Ok((prefix, false));
                    }
                    let size = prefix[6..10]
                        .iter()
                        .fold(0usize, |n, b| (n << 7) | *b as usize);
                    let offset = 10 + size + if prefix[5] & 0x10 != 0 { 10 } else { 0 };
                    if offset + 2 > 8192 {
                        return Ok((prefix, false));
                    }
                    if prefix.len() >= offset + 2 {
                        let native = prefix[offset] == 0xff
                            && prefix[offset + 1] & 0xe0 == 0xe0
                            && prefix[offset + 1] & 0x06 == 0x02;
                        return Ok((prefix, native));
                    }
                }
            } else if prefix[0] == 0xff && prefix[1] & 0xe0 == 0xe0 && prefix[1] & 0x06 == 0x02 {
                return Ok((prefix, true));
            } else {
                return Ok((prefix, false));
            }
        }
        if prefix.len() >= 8192 {
            return Ok((prefix, false));
        }
        let mut block = [0; 1024];
        let n = stdin.read(&mut block)?;
        if n == 0 {
            return Ok((prefix, false));
        }
        prefix.extend_from_slice(&block[..n]);
    }
}

#[cfg(windows)]
fn fallback_stream(
    ffmpeg: &str,
    prefix: Vec<u8>,
    rate: &str,
    channels: &str,
    format: &str,
) -> Result<(), Box<dyn std::error::Error>> {
    use std::{
        ffi::c_void,
        os::windows::io::AsRawHandle,
        process::{Command, Stdio},
    };
    #[repr(C)]
    struct Basic {
        process_time: i64,
        job_time: i64,
        flags: u32,
        min_working: usize,
        max_working: usize,
        active_limit: u32,
        affinity: usize,
        priority: u32,
        scheduling: u32,
    }
    #[repr(C)]
    struct Extended {
        basic: Basic,
        io: [u64; 6],
        process_memory: usize,
        job_memory: usize,
        peak_process: usize,
        peak_job: usize,
    }
    #[link(name = "kernel32")]
    unsafe extern "system" {
        fn CreateJobObjectW(attributes: *mut c_void, name: *const u16) -> *mut c_void;
        fn SetInformationJobObject(
            job: *mut c_void,
            class: u32,
            info: *const c_void,
            length: u32,
        ) -> i32;
        fn AssignProcessToJobObject(job: *mut c_void, process: *mut c_void) -> i32;
        fn CloseHandle(handle: *mut c_void) -> i32;
    }
    struct Job(*mut c_void);
    impl Drop for Job {
        fn drop(&mut self) {
            unsafe {
                CloseHandle(self.0);
            }
        }
    }
    let job = Job(unsafe { CreateJobObjectW(std::ptr::null_mut(), std::ptr::null()) });
    if job.0.is_null() {
        return Err(io::Error::last_os_error().into());
    }
    let mut info: Extended = unsafe { std::mem::zeroed() };
    info.basic.flags = 0x2000;
    if unsafe {
        SetInformationJobObject(
            job.0,
            9,
            &info as *const _ as *const c_void,
            std::mem::size_of::<Extended>() as u32,
        )
    } == 0
    {
        return Err(io::Error::last_os_error().into());
    }
    let mut child = Command::new(ffmpeg)
        .args([
            "-v",
            "error",
            "-nostdin",
            "-probesize",
            "65536",
            "-analyzeduration",
            "500000",
            "-i",
            "pipe:0",
            "-vn",
            "-sn",
            "-dn",
            "-ac",
            channels,
            "-ar",
            rate,
            "-f",
            format,
            "pipe:1",
        ])
        .stdin(Stdio::piped())
        .spawn()?;
    if unsafe { AssignProcessToJobObject(job.0, child.as_raw_handle() as *mut c_void) } == 0 {
        let _ = child.kill();
        let _ = child.wait();
        return Err(io::Error::last_os_error().into());
    }
    let mut input = child.stdin.take().ok_or("missing ffmpeg stdin")?;
    std::thread::spawn(move || {
        let _ = input
            .write_all(&prefix)
            .and_then(|_| io::copy(&mut io::stdin().lock(), &mut input).map(|_| ()));
    });
    let status = child.wait()?;
    if !status.success() {
        return Err(format!("ffmpeg exited with {status}").into());
    }
    Ok(())
}
impl Seek for StdinSource {
    fn seek(&mut self, _: SeekFrom) -> io::Result<u64> {
        Err(io::Error::new(
            io::ErrorKind::Unsupported,
            "stdin is not seekable",
        ))
    }
}
impl MediaSource for StdinSource {
    fn is_seekable(&self) -> bool {
        false
    }
    fn byte_len(&self) -> Option<u64> {
        None
    }
}

fn write_samples(out: &mut impl Write, samples: &[f32], format: &str) -> io::Result<()> {
    #[cfg(target_endian = "little")]
    if format == "f32le" {
        return out.write_all(bytemuck::cast_slice(samples));
    }
    let mut bytes = Vec::with_capacity(samples.len() * 4);
    if format == "f32le" {
        for &s in samples {
            bytes.extend_from_slice(&s.to_le_bytes());
        }
    } else {
        for &s in samples {
            bytes.extend_from_slice(
                &((s * 32768.0).round().clamp(-32768.0, 32767.0) as i16).to_le_bytes(),
            );
        }
    }
    out.write_all(&bytes)
}
fn probe(path: &str) -> Result<(), Box<dyn std::error::Error>> {
    let file = File::open(path)?;
    let size = file.metadata()?.len();
    let mut hint = Hint::new();
    if let Some(ext) = Path::new(path).extension().and_then(|e| e.to_str()) {
        hint.with_extension(ext);
    }
    let format = symphonia::default::get_probe().probe(
        &hint,
        MediaSourceStream::new(Box::new(file), Default::default()),
        FormatOptions::default(),
        MetadataOptions::default(),
    )?;
    let track = format
        .default_track(TrackType::Audio)
        .ok_or("no audio track")?;
    let params = track
        .codec_params
        .as_ref()
        .and_then(|p| p.audio())
        .ok_or("missing audio parameters")?;
    codecs().make_audio_decoder(params, &AudioDecoderOptions::default())?;
    let duration = track
        .time_base
        .zip(track.duration)
        .and_then(|(base, duration)| base.calc_duration(duration))
        .map(|d| d.as_secs_f64())
        .or_else(|| {
            track
                .num_frames
                .zip(params.sample_rate)
                .map(|(frames, rate)| frames as f64 / rate as f64)
        })
        .or_else(|| {
            format
                .media_info()
                .time_base
                .zip(format.media_info().duration)
                .and_then(|(base, duration)| base.calc_duration(duration))
                .map(|d| d.as_secs_f64())
        })
        .unwrap_or(0.0);
    let codec = codecs()
        .get_audio_decoder(params.codec)
        .map(|c| c.codec.info.short_name);
    let bitrate = if duration > 0.0 {
        Some((size as f64 * 8.0 / duration).round() as u64)
    } else {
        None
    };
    println!(
        "{}",
        serde_json::json!({"duration": duration, "codec": codec, "sampleRate": params.sample_rate, "channels": params.channels.as_ref().map(|c| c.count()), "bitrate": bitrate, "hasAudio": true, "container": format.format_info().short_name})
    );
    Ok(())
}
fn run() -> Result<(), Box<dyn std::error::Error>> {
    let mut args: Vec<String> = env::args().collect();
    if args.len() == 3 && args[1] == "probe" {
        return probe(&args[2]);
    }
    let mut prefix = Vec::new();
    if args.len() == 6 && args[1] == "stream" {
        let (head, native) = stream_prefix()?;
        if !native {
            #[cfg(windows)]
            return fallback_stream(&args[2], head, &args[3], &args[4], &args[5]);
            #[cfg(not(windows))]
            return Err("stream fallback requires Windows".into());
        }
        prefix = head;
        args = vec![
            args[0].clone(),
            "-".into(),
            args[3].clone(),
            args[4].clone(),
            args[5].clone(),
        ];
    }
    if args.len() != 5 {
        return Err("usage: mora-decode FILE|- RATE CHANNELS FORMAT".into());
    }
    let rate: u32 = args[2].parse()?;
    let channels: usize = args[3].parse()?;
    let output_format = args[4].as_str();
    if !(8000..=192000).contains(&rate)
        || !(1..=2).contains(&channels)
        || !matches!(output_format, "f32le" | "s16le")
    {
        return Err("invalid output format".into());
    }
    let source: Box<dyn MediaSource> = if args[1] == "-" {
        Box::new(StdinSource {
            prefix: Cursor::new(prefix),
        })
    } else {
        Box::new(File::open(&args[1])?)
    };
    let mut hint = Hint::new();
    if let Some(ext) = Path::new(&args[1]).extension().and_then(|e| e.to_str()) {
        hint.with_extension(ext);
    }
    let mut format = symphonia::default::get_probe().probe(
        &hint,
        MediaSourceStream::new(source, Default::default()),
        FormatOptions::default(),
        MetadataOptions::default(),
    )?;
    let track = format
        .default_track(TrackType::Audio)
        .ok_or("no audio track")?;
    let params = track
        .codec_params
        .as_ref()
        .and_then(|p| p.audio())
        .ok_or("missing audio parameters")?;
    let input_rate = params.sample_rate.ok_or("missing sample rate")?;
    if !(8000..=192000).contains(&input_rate) {
        return Err("unsupported sample rate".into());
    }
    let input_channels = params.channels.as_ref().ok_or("missing channels")?.count();
    if !(1..=2).contains(&input_channels) {
        return Err("multichannel conversion unsupported".into());
    }
    let mut decoder = codecs().make_audio_decoder(params, &AudioDecoderOptions::default())?;
    let track_id = track.id;
    let mut stdout = BufWriter::with_capacity(65536, io::stdout().lock());
    let mut samples = Vec::<f32>::new();
    let mut queue = Vec::<f32>::new();
    let mut resampler = if input_rate != rate {
        Some(Fft::<f32>::new(
            input_rate as usize,
            rate as usize,
            1024,
            channels,
            FixedSync::Input,
        )?)
    } else {
        None
    };
    let mut skip = resampler.as_ref().map_or(0, |r| r.output_delay());
    let mut frames_in: u64 = 0;
    let mut frames_out: u64 = 0;
    let mut started = false;
    while let Some(packet) = format.next_packet()? {
        if packet.track_id != track_id {
            continue;
        }
        let audio = decoder.decode(&packet)?;
        if audio.spec().rate() != input_rate || audio.spec().channels().count() != input_channels {
            return Err("audio format changed".into());
        }
        samples.resize(audio.samples_interleaved(), 0.0);
        audio.copy_to_slice_interleaved(&mut samples);
        frames_in += (samples.len() / input_channels) as u64;
        if input_channels == channels {
            queue.extend_from_slice(&samples);
        } else if input_channels == 1 {
            for &s in &samples {
                queue.extend_from_slice(&[
                    s * std::f32::consts::FRAC_1_SQRT_2,
                    s * std::f32::consts::FRAC_1_SQRT_2,
                ]);
            }
        } else {
            for s in samples.chunks_exact(2) {
                queue.push(
                    (s[0] + s[1])
                        * if output_format == "s16le" {
                            0.5
                        } else {
                            std::f32::consts::FRAC_1_SQRT_2
                        },
                );
            }
        }
        if let Some(r) = resampler.as_mut() {
            let n = r.input_frames_next();
            while queue.len() >= n * channels {
                let input = InterleavedSlice::new(&queue[..n * channels], channels, n)?;
                let output = r.process(&input, None)?;
                let data = output.take_data();
                let start = skip.min(data.len() / channels);
                skip -= start;
                write_samples(&mut stdout, &data[start * channels..], output_format)?;
                frames_out += (data.len() / channels - start) as u64;
                queue.drain(..n * channels);
            }
        } else {
            write_samples(&mut stdout, &queue, output_format)?;
            queue.clear();
        }
        if !started && (frames_out > 0 || (resampler.is_none() && !samples.is_empty())) {
            stdout.flush()?;
            started = true;
        }
    }
    if let Some(r) = resampler.as_mut() {
        let wanted = (frames_in * rate as u64).div_ceil(input_rate as u64);
        while frames_out < wanted {
            let n = r.input_frames_next();
            let valid = (queue.len() / channels).min(n);
            queue.resize(n * channels, 0.0);
            let input = InterleavedSlice::new(&queue[..n * channels], channels, n)?;
            let output = r.process(
                &input,
                Some(&Indexing {
                    partial_len: Some(valid),
                    ..Default::default()
                }),
            )?;
            let data = output.take_data();
            let start = skip.min(data.len() / channels);
            skip -= start;
            let count = ((wanted - frames_out) as usize).min(data.len() / channels - start);
            write_samples(
                &mut stdout,
                &data[start * channels..(start + count) * channels],
                output_format,
            )?;
            frames_out += count as u64;
            queue.clear();
        }
    }
    stdout.flush()?;
    Ok(())
}
fn main() {
    if let Err(e) = run() {
        eprintln!("mora-decode: {e}");
        std::process::exit(1);
    }
}
