//! 任务卡上的「持续任务 / 定时任务」。
//!
//! 排期写在卡片 frontmatter 里，和其它字段一样属于用户仓库的 markdown：
//!
//! ```yaml
//! recurrence: 2h          # 每隔一段时间跑一次（30m / 90m / 2h / 1d）
//! schedule: '09:30'       # 每天这个点跑一次
//! schedule: '2026-11-20 09:30'  # 只在这个时间跑一次
//!
//! ```
//!
//! 两个字段互斥。这里只做解析与时间计算，不碰文件也不碰数据库：
//! 「上次什么时候跑的」由 router 那边记录，判定在 tick 里。

use chrono::{Datelike, Local, NaiveDate, NaiveTime, TimeZone, Timelike};

/// 间隔任务的最小/最大值。太小会变成忙等，太大约等于不跑。
pub const MIN_INTERVAL_MINUTES: u32 = 1;
pub const MAX_INTERVAL_MINUTES: u32 = 30 * 24 * 60;

/// 任务类型。
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Kind {
    /// 每隔 N 分钟跑一次。
    Interval,
    /// 每天固定时刻跑一次。
    Daily,
    /// 只在指定时刻跑一次。
    Once,
}

impl Kind {
    pub fn as_str(self) -> &'static str {
        match self {
            Kind::Interval => "interval",
            Kind::Daily => "daily",
            Kind::Once => "once",
        }
    }
}

/// 解析后的排期。
#[derive(Clone, Debug, PartialEq)]
pub struct Spec {
    pub kind: Kind,
    /// 间隔任务的分钟数。
    pub minutes: Option<u32>,
    /// 每日任务的时间（本地时区，`HH:MM`）。
    pub time: Option<String>,
    /// 一次性任务的归一化时间（本地时区，`YYYY-MM-DD HH:MM`）。
    pub at_text: Option<String>,
    /// 一次性任务的时间戳（毫秒）。
    pub at_ms: Option<i64>,
}

impl Spec {
    /// 交给前端的形状。`last_fired` 由 router 的排期表提供；看板读卡时还不知道。
    pub fn to_dto(&self, last_fired: Option<i64>) -> crate::tasks::model::TaskSchedule {
        crate::tasks::model::TaskSchedule {
            kind: self.kind.as_str().to_string(),
            minutes: self.minutes,
            time: self.time.clone(),
            at: self.at_text.clone(),
            last_run_at: last_fired,
            // 间隔任务要等第一次跑过才知道下一轮什么时候（没有起点就不编一个）。
            next_run_at: self.due_at(last_fired),
        }
    }

    /// 下一次该跑的时刻。`None` 表示「还算不出来」（间隔任务还没有起点）。
    ///
    /// 注意返回值可能已经过去——那正是「现在就该跑」的意思，由调用方判断。
    pub fn due_at(&self, last_fired: Option<i64>) -> Option<i64> {
        match self.kind {
            Kind::Interval => {
                let minutes = self.minutes?;
                last_fired.map(|at| at + i64::from(minutes) * 60_000)
            }
            Kind::Daily => {
                let time = self.time.as_deref().and_then(parse_time)?;
                match last_fired {
                    // 还没跑过：看今天这个时刻。已经过了的话，就是「现在补一次」。
                    None => today_at(&time, now_ms()).map(|value| value.timestamp_millis()),
                    Some(base) => {
                        next_daily_after(&time, base).map(|value| value.timestamp_millis())
                    }
                }
            }
            Kind::Once => self.at_ms,
        }
    }

    /// 这个排期是不是已经用掉了（一次性任务只跑一次）。
    ///
    /// 判据是「触发记录已经追上这个时刻」，不是「这张卡跑过」：`2026-11-20 09:30`
    /// 跑过一次之后，用户把它改成 `2026-12-01 09:00` 是一张新的定时任务，
    /// 不该因为卡片有历史就永远不再触发。
    pub fn spent(&self, last_fired: Option<i64>) -> bool {
        match (self.kind, self.at_ms, last_fired) {
            (Kind::Once, Some(at), Some(fired)) => fired >= at,
            _ => false,
        }
    }
}

fn now_ms() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|duration| duration.as_millis() as i64)
        .unwrap_or(0)
}

/// 把 `recurrence` / `schedule` 两个字段解析成一个排期。
///
/// 两个都给是写法错误：不猜用户想要哪一个，交给调用方报错。
pub fn parse(recurrence: Option<&str>, schedule: Option<&str>) -> Result<Option<Spec>, String> {
    let recurrence = recurrence.map(str::trim).filter(|value| !value.is_empty());
    let schedule = schedule.map(str::trim).filter(|value| !value.is_empty());
    match (recurrence, schedule) {
        (Some(_), Some(_)) => Err("conflicting-schedule".into()),
        (Some(value), None) => parse_interval(value).map(Some),
        (None, Some(value)) => parse_moment(value).map(Some),
        (None, None) => Ok(None),
    }
}

/// `30m` / `90m` / `2h` / `1d` / `45`（纯数字按分钟）。
fn parse_interval(value: &str) -> Result<Spec, String> {
    let text = value.trim().to_lowercase();
    let (digits, unit) = text.split_at(
        text.find(|c: char| !c.is_ascii_digit())
            .unwrap_or(text.len()),
    );
    let number: u32 = digits.parse().map_err(|_| "invalid-recurrence")?;
    let minutes = match unit.trim() {
        "" | "m" | "min" | "mins" | "分钟" => number,
        "h" | "hr" | "hour" | "hours" | "小时" => number.saturating_mul(60),
        "d" | "day" | "days" | "天" => number.saturating_mul(24 * 60),
        _ => return Err("invalid-recurrence".into()),
    };
    if !(MIN_INTERVAL_MINUTES..=MAX_INTERVAL_MINUTES).contains(&minutes) {
        log::warn!(
            "task recurrence out of range, rejected: value={value} minutes={minutes} min={MIN_INTERVAL_MINUTES} max={MAX_INTERVAL_MINUTES}"
        );
        return Err("invalid-recurrence".into());
    }
    Ok(Spec {
        kind: Kind::Interval,
        minutes: Some(minutes),
        time: None,
        at_text: None,
        at_ms: None,
    })
}

/// `09:30` 是每天；`2026-11-20 09:30` 是一次。
fn parse_moment(value: &str) -> Result<Spec, String> {
    if let Some(time) = parse_time(value) {
        return Ok(Spec {
            kind: Kind::Daily,
            minutes: None,
            time: Some(format!("{:02}:{:02}", time.hour(), time.minute())),
            at_text: None,
            at_ms: None,
        });
    }
    for format in ["%Y-%m-%d %H:%M", "%Y-%m-%dT%H:%M"] {
        if let Ok(naive) = chrono::NaiveDateTime::parse_from_str(value, format) {
            let at = Local
                .from_local_datetime(&naive)
                .earliest()
                .or_else(|| Local.from_local_datetime(&naive).latest())
                .ok_or("invalid-schedule")?;
            return Ok(Spec {
                kind: Kind::Once,
                minutes: None,
                time: None,
                at_text: Some(format!(
                    "{:04}-{:02}-{:02} {:02}:{:02}",
                    at.year(),
                    at.month(),
                    at.day(),
                    at.hour(),
                    at.minute()
                )),
                at_ms: Some(at.timestamp_millis()),
            });
        }
    }
    Err("invalid-schedule".into())
}

fn parse_time(value: &str) -> Option<NaiveTime> {
    for format in ["%H:%M", "%H:%M:%S"] {
        if let Ok(time) = NaiveTime::parse_from_str(value.trim(), format) {
            return Some(time);
        }
    }
    None
}

/// `base` 当天的这个时刻（可能已经过去）。
fn today_at(time: &NaiveTime, base: i64) -> Option<chrono::DateTime<Local>> {
    let local = Local.timestamp_millis_opt(base).single()?;
    let naive = local.date_naive().and_time(*time);
    Local
        .from_local_datetime(&naive)
        .earliest()
        .or_else(|| Local.from_local_datetime(&naive).latest())
}

/// `base` 之后（严格大于）的下一个 `time` 时刻。
fn next_daily_after(time: &NaiveTime, base: i64) -> Option<chrono::DateTime<Local>> {
    let local = Local.timestamp_millis_opt(base).single()?;
    let mut date: NaiveDate = local.date_naive();
    for _ in 0..2 {
        let naive = date.and_time(*time);
        if let Some(candidate) = Local
            .from_local_datetime(&naive)
            .earliest()
            .or_else(|| Local.from_local_datetime(&naive).latest())
        {
            if candidate.timestamp_millis() > base {
                return Some(candidate);
            }
        }
        date = date.succ_opt()?;
    }
    None
}

#[cfg(test)]
mod tests {
    use super::*;

    fn at(text: &str) -> i64 {
        Local
            .from_local_datetime(
                &chrono::NaiveDateTime::parse_from_str(text, "%Y-%m-%d %H:%M").unwrap(),
            )
            .earliest()
            .unwrap()
            .timestamp_millis()
    }

    #[test]
    fn interval_specs_accept_the_usual_units() {
        let spec = parse(Some("2h"), None).unwrap().unwrap();
        assert_eq!(spec.kind, Kind::Interval);
        assert_eq!(spec.minutes, Some(120));
        assert_eq!(parse(Some("45"), None).unwrap().unwrap().minutes, Some(45));
        assert_eq!(
            parse(Some("1d"), None).unwrap().unwrap().minutes,
            Some(1440)
        );
        assert_eq!(
            parse(Some(" 30 mins "), None).unwrap().unwrap().minutes,
            Some(30)
        );
    }

    #[test]
    fn absurd_intervals_are_rejected_with_a_log() {
        assert_eq!(parse(Some("0m"), None).unwrap_err(), "invalid-recurrence");
        assert_eq!(parse(Some("999d"), None).unwrap_err(), "invalid-recurrence");
        assert_eq!(parse(Some("soon"), None).unwrap_err(), "invalid-recurrence");
    }

    #[test]
    fn a_clock_time_means_every_day() {
        let spec = parse(None, Some("09:30")).unwrap().unwrap();
        assert_eq!(spec.kind, Kind::Daily);
        assert_eq!(spec.time.as_deref(), Some("09:30"));

        let first = spec.due_at(Some(at("2026-11-17 08:00"))).unwrap();
        assert_eq!(first, at("2026-11-17 09:30"));
        // 今天已经过了这个点：顺延到明天，而不是当成立刻要跑。
        let next = spec.due_at(Some(at("2026-11-17 10:00"))).unwrap();
        assert_eq!(next, at("2026-11-18 09:30"));
    }

    #[test]
    fn a_full_datetime_means_exactly_once() {
        let spec = parse(None, Some("2026-11-20 09:30")).unwrap().unwrap();
        assert_eq!(spec.kind, Kind::Once);
        assert_eq!(spec.at_text.as_deref(), Some("2026-11-20 09:30"));
        assert!(!spec.spent(None));
        // 触发记录早于这个时刻（比如卡片以前是间隔任务）：还没跑过这一刻。
        assert!(!spec.spent(Some(at("2026-11-01 09:00"))));
        assert!(spec.spent(Some(at("2026-11-20 09:30"))));
        assert!(spec.spent(Some(at("2026-11-21 09:00"))));
    }

    /// 一次性的卡跑过一次之后被改成另一个时刻：那是新的一次，要能再跑。
    #[test]
    fn moving_a_one_shot_to_a_new_moment_makes_it_live_again() {
        let first = parse(None, Some("2026-11-20 09:30")).unwrap().unwrap();
        let second = parse(None, Some("2026-12-01 09:00")).unwrap().unwrap();
        assert!(first.spent(Some(at("2026-11-20 09:30"))));
        assert!(!second.spent(Some(at("2026-11-20 09:30"))));
        assert_eq!(
            second.due_at(Some(at("2026-11-20 09:30"))),
            Some(at("2026-12-01 09:00"))
        );
    }

    #[test]
    fn a_daily_schedule_before_its_time_waits_for_today() {
        let spec = parse(None, Some("09:30")).unwrap().unwrap();
        // 还没跑过：今天是 08:00，下一次就是今天 09:30；
        // 但今天是 10:00 时，今天那个时刻已经过去，算「现在补一次」。
        let today = spec.due_at(None).expect("today");
        let local = Local.timestamp_millis_opt(today).single().unwrap();
        assert_eq!(
            format!("{:02}:{:02}", local.hour(), local.minute()),
            "09:30"
        );
    }

    #[test]
    fn an_interval_needs_a_starting_point() {
        let spec = parse(Some("90m"), None).unwrap().unwrap();
        assert_eq!(spec.due_at(None), None);
        assert_eq!(spec.due_at(Some(1_000_000)), Some(1_000_000 + 90 * 60_000));
    }

    #[test]
    fn two_schedule_fields_at_once_are_a_mistake() {
        assert_eq!(
            parse(Some("2h"), Some("09:30")).unwrap_err(),
            "conflicting-schedule"
        );
        assert!(parse(None, None).unwrap().is_none());
        assert!(parse(Some("  "), Some("")).unwrap().is_none());
    }

    #[test]
    fn the_dto_carries_the_rule_and_the_next_run() {
        let spec = parse(Some("2h"), None).unwrap().unwrap();
        let dto = spec.to_dto(Some(1_000));
        assert_eq!(dto.kind, "interval");
        assert_eq!(dto.next_run_at, Some(1_000 + 120 * 60_000));
    }
}
