use super::primitives::normalization_gain;
use serde_json::Value;

pub(crate) struct Ctx<'a> {
    pub a: &'a Value,
    pub b: &'a Value,
    pub s: &'a Value,
    pub requested_at: Option<f64>,
    pub vocal_repair: Option<Value>,
    pub fixed: Option<Value>,
    pub region_a: Option<Value>,
    pub region_b: Option<Value>,
}
impl Ctx<'_> {
    pub fn gain_a(&self) -> f64 {
        normalization_gain(&self.a["analysis"], self.s["loudnessTarget"].as_f64())
    }
    pub fn gain_b(&self) -> f64 {
        normalization_gain(&self.b["analysis"], self.s["loudnessTarget"].as_f64())
    }
    pub fn base(&self, method: &str) -> Value {
        super::simple::base_plan(self.a, self.b, self.s, method)
    }
}
