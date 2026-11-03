use cpal::traits::{DeviceTrait, HostTrait, StreamTrait};
use mora_audio::mixer::Mixer;
use serde_json::{Value, json};
use std::{
    fs::File,
    io::{self, BufRead, BufReader, BufWriter, Read, Write},
    sync::{
        Arc,
        atomic::{AtomicU64, Ordering},
        mpsc,
    },
    thread,
    time::{Duration, Instant},
};

fn devices() -> Result<Vec<(String, String, cpal::Device)>, String> {
    let host = cpal::default_host();
    let mut seen = std::collections::HashMap::<String, usize>::new();
    host.output_devices()
        .map_err(|e| e.to_string())?
        .map(|d| {
            let name = d.name().map_err(|e| e.to_string())?;
            let count = seen.entry(name.clone()).or_default();
            let id = format!("{}:{}", *count, name);
            *count += 1;
            Ok((id, name, d))
        })
        .collect()
}
fn select(id: &str) -> Result<cpal::Device, String> {
    if id.is_empty() {
        cpal::default_host()
            .default_output_device()
            .ok_or("No default audio output".into())
    } else {
        devices()?
            .into_iter()
            .find(|(key, _, _)| key == id)
            .map(|(_, _, d)| d)
            .ok_or("Audio output is no longer available".into())
    }
}
fn config(device: &cpal::Device, sr: Option<u32>) -> Result<cpal::SupportedStreamConfig, String> {
    let ranges: Vec<_> = device
        .supported_output_configs()
        .map_err(|e| e.to_string())?
        .collect();
    for rate in sr.map_or(vec![48000, 44100, 96000, 88200], |s| vec![s]) {
        if let Some(r) = ranges.iter().find(|r| {
            r.channels() == 2
                && r.min_sample_rate().0 <= rate
                && r.max_sample_rate().0 >= rate
                && r.sample_format() == cpal::SampleFormat::F32
        }) {
            return Ok((*r).with_sample_rate(cpal::SampleRate(rate)));
        }
    }
    Err("Audio output must support stereo float PCM at 44.1, 48, 88.2 or 96 kHz".into())
}
struct Output {
    _stream: cpal::Stream,
    producer: rtrb::Producer<[f32; 2]>,
    capture: rtrb::Consumer<[f32; 2]>,
    underruns: Arc<AtomicU64>,
    presented: Arc<AtomicU64>,
    error: Arc<std::sync::Mutex<Option<String>>>,
}
fn output(device: &cpal::Device, c: &cpal::SupportedStreamConfig) -> Result<Output, String> {
    let (mut producer, mut consumer) = rtrb::RingBuffer::<[f32; 2]>::new(4096);
    let (mut monitor, capture) = rtrb::RingBuffer::<[f32; 2]>::new(8192);
    let underruns = Arc::new(AtomicU64::new(0));
    let u = underruns.clone();
    let presented = Arc::new(AtomicU64::new(0));
    let p = presented.clone();
    let error = Arc::new(std::sync::Mutex::new(None));
    let err = error.clone();
    // The device callback only moves fixed-size frames. DSP, JSON, I/O and allocations run on the producer.
    let stream = device
        .build_output_stream(
            &c.config(),
            move |data: &mut [f32], _| {
                let mut missed = false;
                for frame in data.chunks_exact_mut(2) {
                    let sample = consumer.pop().unwrap_or_else(|_| {
                        missed = true;
                        [0., 0.]
                    });
                    frame.copy_from_slice(&sample);
                    let _ = monitor.push(sample);
                }
                if missed {
                    u.fetch_add(1, Ordering::Relaxed);
                }
                p.fetch_add((data.len() / 2) as u64, Ordering::Relaxed);
            },
            move |e| {
                if let Ok(mut slot) = err.lock() {
                    *slot = Some(e.to_string());
                }
            },
            None,
        )
        .map_err(|e| e.to_string())?;
    for _ in 0..2048 {
        producer.push([0., 0.]).map_err(|e| e.to_string())?;
    }
    stream.play().map_err(|e| e.to_string())?;
    Ok(Output {
        _stream: stream,
        producer,
        capture,
        underruns,
        presented,
        error,
    })
}
fn stats(times: &mut [f64], frames: u64, sr: u32) -> Value {
    times.sort_by(f64::total_cmp);
    let percentile = |p: f64| {
        times
            .get(((times.len().saturating_sub(1)) as f64 * p).round() as usize)
            .copied()
            .unwrap_or(0.)
    };
    json!({"blocks":times.len(),"audioSeconds":frames as f64/sr as f64,"renderMs":times.iter().sum::<f64>(),"p50Ms":percentile(0.5),"p95Ms":percentile(0.95),"p99Ms":percentile(0.99),"maxMs":percentile(1.)})
}
fn offline(input: &str, pcm: &str, report: &str) -> Result<(), String> {
    let fixture: Value = serde_json::from_reader(BufReader::new(
        File::open(input).map_err(|e| e.to_string())?,
    ))
    .map_err(|e| e.to_string())?;
    let sr = fixture["sampleRate"].as_u64().ok_or("Missing sampleRate")? as u32;
    let mut mixer = Mixer::new(sr)?;
    let ops = fixture["ops"].as_array().ok_or("Missing ops")?;
    let mut events = Vec::new();
    let mut times = Vec::new();
    let mut frames = 0u64;
    let mut out = BufWriter::new(File::create(pcm).map_err(|e| e.to_string())?);
    for op in ops {
        if op["cmd"] == "render" {
            let count = op["frames"]
                .as_u64()
                .filter(|n| *n <= sr as u64 * 3600)
                .ok_or("Invalid render length")? as usize;
            for at in (0..count).step_by(128) {
                let n = 128.min(count - at);
                let (mut l, mut r) = ([0f32; 128], [0f32; 128]);
                let start = Instant::now();
                mixer.process(&mut l[..n], &mut r[..n]);
                times.push(start.elapsed().as_secs_f64() * 1000.);
                for i in 0..n {
                    out.write_all(&l[i].to_le_bytes())
                        .and_then(|_| out.write_all(&r[i].to_le_bytes()))
                        .map_err(|e| e.to_string())?;
                }
                frames += n as u64;
                events.extend(mixer.take_events());
            }
        } else {
            mixer.command(op)?;
            events.extend(mixer.take_events());
        }
    }
    out.flush().map_err(|e| e.to_string())?;
    serde_json::to_writer(
        File::create(report).map_err(|e| e.to_string())?,
        &json!({"sampleRate":sr,"events":events,"metrics":stats(&mut times,frames,sr)}),
    )
    .map_err(|e| e.to_string())
}
fn realtime(id: &str) -> Result<(), String> {
    let device = select(id)?;
    let c = config(&device, None)?;
    let sr = c.sample_rate().0;
    let mut sink = output(&device, &c)?;
    let mut mixer = Mixer::new(sr)?;
    let (send, receive) = mpsc::sync_channel::<Value>(256);
    let (wire, out) = mpsc::sync_channel::<Value>(256);
    let writer = thread::spawn(move || {
        let mut stdout = BufWriter::new(io::stdout().lock());
        for v in out {
            if serde_json::to_writer(&mut stdout, &v).is_err()
                || stdout.write_all(b"\n").is_err()
                || stdout.flush().is_err()
            {
                break;
            }
        }
    });
    wire.send(json!({"type":"ready","sampleRate":sr,"engine":"rust","queueFrames":2048}))
        .map_err(|e| e.to_string())?;
    thread::spawn(move || {
        let stdin = io::stdin();
        let mut reader = stdin.lock();
        loop {
            let mut line = String::new();
            match (&mut reader).take(400_001).read_line(&mut line) {
                Ok(0) | Err(_) => break,
                Ok(_) if line.len() > 400_000 => break,
                Ok(_) => {}
            }
            match serde_json::from_str::<Value>(&line) {
                Ok(v) => {
                    if send.send(v).is_err() {
                        return;
                    }
                }
                Err(_) => break,
            }
        }
        let _ = send.send(json!({"cmd":"quit"}));
    });
    let mut last = Instant::now();
    let mut times = Vec::with_capacity(sr as usize / 128 + 32);
    let mut rendered = 0u64;
    let mut waveform = Vec::with_capacity(2048);
    let mut quitting = false;
    let mut suspended = false;
    while !quitting {
        for _ in 0..64 {
            let v = match receive.try_recv() {
                Ok(v) => v,
                Err(mpsc::TryRecvError::Empty) => break,
                Err(_) => {
                    quitting = true;
                    break;
                }
            };
            if v["cmd"] == "quit" {
                quitting = true;
                break;
            }
            let result = match v["cmd"].as_str() {
                Some("suspend") => sink
                    ._stream
                    .pause()
                    .map(|()| suspended = true)
                    .map_err(|e| e.to_string()),
                Some("resume") => sink
                    ._stream
                    .play()
                    .map(|()| suspended = false)
                    .map_err(|e| e.to_string()),
                Some("output") => {
                    let id = v["device"].as_str().unwrap_or("");
                    select(id)
                        .and_then(|d| config(&d, Some(sr)).and_then(|c| output(&d, &c)))
                        .map(|o| {
                            sink = o;
                            suspended = false;
                        })
                }
                _ => mixer.command(&v),
            };
            wire.send(match result {
                Ok(()) => json!({"type":"ack","request":v["request"]}),
                Err(e) => json!({"type":"error","request":v["request"],"error":e}),
            })
            .map_err(|e| e.to_string())?;
        }
        if quitting {
            break;
        }
        if let Some(error) = sink.error.lock().map_err(|e| e.to_string())?.take() {
            return Err(format!("Audio device error: {error}"));
        }
        while !suspended && sink.producer.slots() >= 128 && sink.producer.slots() > 4096 - 2048 {
            let (mut l, mut r) = ([0.; 128], [0.; 128]);
            let start = Instant::now();
            mixer.process(&mut l, &mut r);
            times.push(start.elapsed().as_secs_f64() * 1000.);
            rendered += 128;
            for i in 0..128 {
                sink.producer
                    .push([l[i], r[i]])
                    .map_err(|e| e.to_string())?;
            }
        }
        for event in mixer.take_events() {
            wire.send(event).map_err(|e| e.to_string())?;
        }
        while let Ok(frame) = sink.capture.pop() {
            if waveform.len() == 2048 {
                let _ = wire.try_send(json!({"type":"waveform","samples":waveform}));
                waveform.clear();
            }
            waveform.push((frame[0] as f64 + frame[1] as f64) * 0.5);
        }
        if last.elapsed() >= Duration::from_secs(1) {
            let metrics = stats(&mut times, rendered, sr);
            wire.send(json!({"type":"audioHealth","maxRenderMs":metrics["maxMs"],"slowBlocks":times.iter().filter(|t|**t>128000./sr as f64).count(),"p95Ms":metrics["p95Ms"],"p99Ms":metrics["p99Ms"],"deviceUnderruns":sink.underruns.load(Ordering::Relaxed),"presentedFrames":sink.presented.load(Ordering::Relaxed)})).map_err(|e|e.to_string())?;
            times.clear();
            rendered = 0;
            last = Instant::now();
        }
        thread::sleep(Duration::from_millis(1));
    }
    drop(sink);
    drop(wire);
    let _ = writer.join();
    Ok(())
}
fn analyze(input: &str, output: &str, expected_seconds: f64) -> Result<(), String> {
    let mut reader: Box<dyn Read> = if input == "-" {
        Box::new(io::stdin().lock())
    } else {
        Box::new(BufReader::new(
            File::open(input).map_err(|e| e.to_string())?,
        ))
    };
    let mut accumulator = mora_audio::analysis::AnalysisAccumulator::new(expected_seconds);
    let mut bytes = [0u8; 65536 + 7];
    let mut carry = 0;
    let mut left = [0f32; 8192];
    let mut right = [0f32; 8192];
    let mut frames = 0usize;
    loop {
        let count = reader
            .read(&mut bytes[carry..65536])
            .map_err(|e| e.to_string())?;
        if count == 0 {
            break;
        }
        let available = carry + count;
        let complete = available / 8;
        for i in 0..complete {
            left[i] = f32::from_le_bytes(bytes[i * 8..i * 8 + 4].try_into().unwrap());
            right[i] = f32::from_le_bytes(bytes[i * 8 + 4..i * 8 + 8].try_into().unwrap());
        }
        accumulator.push(&left[..complete], &right[..complete])?;
        frames += complete;
        carry = available - complete * 8;
        bytes.copy_within(complete * 8..available, 0);
    }
    if carry != 0 {
        return Err("Unaligned stereo PCM".into());
    }
    if frames < 4410 {
        return Err("файл не содержит звука".into());
    }
    let result = accumulator.finish()?;
    if output == "-" {
        serde_json::to_writer(BufWriter::new(io::stdout().lock()), &result)
            .map_err(|e| e.to_string())
    } else {
        serde_json::to_writer(
            BufWriter::new(File::create(output).map_err(|e| e.to_string())?),
            &result,
        )
        .map_err(|e| e.to_string())
    }
}

fn compute() -> Result<(), String> {
    let mut raw = Vec::new();
    io::stdin()
        .take(256 * 1024 * 1024 + 1)
        .read_to_end(&mut raw)
        .map_err(|e| e.to_string())?;
    if raw.len() > 256 * 1024 * 1024 {
        return Err("Core request is too large".into());
    }
    let input: Value = serde_json::from_slice(&raw).map_err(|e| e.to_string())?;
    let result = match input["operation"].as_str() {
        Some("plan") => mora_audio::plan::plan(&input),
        Some("phrase") => mora_audio::phrase_mix::dispatch(&input),
        Some("render") => mora_audio::render::render(&input),
        _ => Err("Unknown core operation".into()),
    }?;
    serde_json::to_writer(BufWriter::new(io::stdout().lock()), &result).map_err(|e| e.to_string())
}

fn main() {
    let args: Vec<_> = std::env::args().collect();
    let result=match args.get(1).map(String::as_str) {
        Some("--offline") if args.len()==5=>offline(&args[2],&args[3],&args[4]),
        Some("--devices")=>devices().and_then(|ds| { let list:Vec<_>=ds.iter().map(|(id,name,_)|json!({"deviceId":id,"label":name})).collect();serde_json::to_writer(io::stdout(),&list).map_err(|e|e.to_string()) }),
        Some("--realtime")=>realtime(args.get(2).map_or("",String::as_str)),
        Some("--analyze") if args.len()>=4=>analyze(&args[2],&args[3],args.get(4).and_then(|v|v.parse().ok()).unwrap_or(300.)),
        Some("--compute")=>compute(),
        Some("--compute-server")=>mora_audio::compute::server(),
        _=>Err("Usage: mora-audio --realtime [device] | --devices | --offline input.json output.f32 report.json | --analyze input.f32 output.json [expectedSeconds] | --compute".into()),
    };
    if let Err(error) = result {
        let _ = serde_json::to_writer(io::stdout(), &json!({"type":"fatal","error":error}));
        println!();
        std::process::exit(1);
    }
}
