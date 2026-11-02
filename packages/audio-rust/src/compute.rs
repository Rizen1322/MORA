use serde_json::{Value, json};
use std::io::{self, BufRead, Read, Write};

pub fn dispatch(input: &Value) -> Result<Value, String> {
    match input["operation"].as_str() {
        Some("plan") => crate::plan::plan(input),
        Some("phrase") => crate::phrase_mix::dispatch(input),
        Some("render") => crate::render::render(input),
        _ => Err("Unknown core operation".into()),
    }
}

/// One bounded request at a time; a failed computation does not poison the next request.
pub fn serve(reader: &mut impl BufRead, writer: &mut impl Write) -> Result<(), String> {
    const MAX: usize = 256 * 1024 * 1024;
    loop {
        let mut raw = Vec::new();
        let count = Read::by_ref(reader).take(MAX as u64 + 1)
            .read_until(b'\n', &mut raw).map_err(|e| e.to_string())?;
        if count == 0 { return Ok(()); }
        if raw.len() > MAX || raw.last() != Some(&b'\n') {
            return Err("Core request is too large or incomplete".into());
        }
        let input: Value = serde_json::from_slice(&raw).map_err(|e| e.to_string())?;
        let request = input["request"].as_u64().ok_or("Invalid core request ID")?;
        let output = match dispatch(&input["value"]) {
            Ok(value) => json!({"request":request,"ok":true,"value":value}),
            Err(error) => json!({"request":request,"ok":false,"error":error}),
        };
        serde_json::to_writer(&mut *writer, &output).map_err(|e| e.to_string())?;
        writer.write_all(b"\n").and_then(|_| writer.flush()).map_err(|e| e.to_string())?;
    }
}

pub fn server() -> Result<(), String> {
    serve(&mut io::BufReader::new(io::stdin().lock()), &mut io::BufWriter::new(io::stdout().lock()))
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn failed_request_does_not_end_session() {
        let requests = b"{\"request\":1,\"value\":{\"operation\":\"bad\"}}\n{\"request\":2,\"value\":{\"operation\":\"bad\"}}\n";
        let mut output = Vec::new();
        serve(&mut &requests[..], &mut output).unwrap();
        let rows: Vec<Value> = String::from_utf8(output).unwrap().lines()
            .map(|s| serde_json::from_str(s).unwrap()).collect();
        assert_eq!(rows.len(), 2);
        assert_eq!(rows[1]["request"], 2);
        assert_eq!(rows[1]["ok"], false);
    }
    #[test]
    fn incomplete_or_invalid_envelope_is_rejected() {
        assert!(serve(&mut &b"{}"[..], &mut Vec::new()).is_err());
        assert!(serve(&mut &b"{}\n"[..], &mut Vec::new()).is_err());
    }
}
