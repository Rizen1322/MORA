use serde_json::Value;

/// Match JSON.stringify's number spelling for IDs shared with the existing clients.
pub fn stringify(value: &Value) -> String {
    match value {
        Value::Number(number) => {
            let Some(value) = number.as_f64() else {
                return "null".into();
            };
            if value == 0. {
                return "0".into();
            }
            let raw = serde_json::to_string(&value).unwrap();
            let (mantissa, exponent) = raw
                .split_once('e')
                .map_or((raw.as_str(), None), |(m, e)| (m, e.parse::<i32>().ok()));
            let mantissa = mantissa.strip_suffix(".0").unwrap_or(mantissa);
            if let Some(exponent) = exponent {
                if value.abs() >= 1e-6 && value.abs() < 1e21 {
                    let negative = mantissa.starts_with('-');
                    let unsigned = mantissa.trim_start_matches('-');
                    let original_dot = unsigned.find('.').unwrap_or(unsigned.len()) as i32;
                    let digits = unsigned.replace('.', "");
                    let dot = original_dot + exponent;
                    let magnitude = if dot <= 0 {
                        format!("0.{}{}", "0".repeat((-dot) as usize), digits)
                    } else if dot as usize >= digits.len() {
                        format!("{}{}", digits, "0".repeat(dot as usize - digits.len()))
                    } else {
                        format!("{}.{}", &digits[..dot as usize], &digits[dot as usize..])
                    };
                    return format!("{}{}", if negative { "-" } else { "" }, magnitude);
                }
                return format!(
                    "{}e{}{}",
                    mantissa,
                    if exponent >= 0 { "+" } else { "" },
                    exponent
                );
            }
            mantissa.to_owned()
        }
        Value::Array(values) => format!(
            "[{}]",
            values.iter().map(stringify).collect::<Vec<_>>().join(",")
        ),
        Value::Object(values) => format!(
            "{{{}}}",
            values
                .iter()
                .map(|(key, value)| format!(
                    "{}:{}",
                    serde_json::to_string(key).unwrap(),
                    stringify(value)
                ))
                .collect::<Vec<_>>()
                .join(",")
        ),
        _ => serde_json::to_string(value).unwrap(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    #[test]
    fn javascript_numbers_and_order() {
        for (value, expected) in [
            (1., "1"),
            (-0., "0"),
            (1e-6, "0.000001"),
            (1e-7, "1e-7"),
            (1e20, "100000000000000000000"),
            (1e21, "1e+21"),
            (-1.25e-5, "-0.0000125"),
        ] {
            assert_eq!(stringify(&json!(value)), expected);
        }
        let value: Value = serde_json::from_str("{\"z\":1.0,\"a\":[2.0,null]}").unwrap();
        assert_eq!(stringify(&value), "{\"z\":1,\"a\":[2,null]}");
    }
}
