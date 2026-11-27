use std::{
    io,
    ops::{Deref, DerefMut},
    os::windows::io::{AsRawHandle, FromRawHandle, OwnedHandle},
    process::{Child, Command},
};
use windows_sys::Win32::System::JobObjects::{
    AssignProcessToJobObject, CreateJobObjectW, JobObjectExtendedLimitInformation,
    SetInformationJobObject, JOBOBJECT_EXTENDED_LIMIT_INFORMATION, JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE,
};

pub struct ManagedChild {
    child: Child,
    job: Option<OwnedHandle>,
}

impl ManagedChild {
    pub fn spawn(command: &mut Command) -> io::Result<Self> {
        let handle = unsafe { CreateJobObjectW(std::ptr::null(), std::ptr::null()) };
        if handle.is_null() {
            return Err(io::Error::last_os_error());
        }
        let job = unsafe { OwnedHandle::from_raw_handle(handle) };
        let mut limits = JOBOBJECT_EXTENDED_LIMIT_INFORMATION::default();
        limits.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
        let configured = unsafe {
            SetInformationJobObject(
                job.as_raw_handle(),
                JobObjectExtendedLimitInformation,
                (&limits as *const JOBOBJECT_EXTENDED_LIMIT_INFORMATION).cast(),
                std::mem::size_of_val(&limits) as u32,
            )
        };
        if configured == 0 {
            return Err(io::Error::last_os_error());
        }

        let mut child = command.spawn()?;
        let assigned = unsafe { AssignProcessToJobObject(job.as_raw_handle(), child.as_raw_handle()) };
        if assigned == 0 {
            let error = io::Error::last_os_error();
            let _ = child.kill();
            let _ = child.wait();
            return Err(error);
        }
        Ok(Self { child, job: Some(job) })
    }

    pub fn close_job(&mut self) {
        self.job.take();
    }
}

impl Deref for ManagedChild {
    type Target = Child;

    fn deref(&self) -> &Self::Target {
        &self.child
    }
}

impl DerefMut for ManagedChild {
    fn deref_mut(&mut self) -> &mut Self::Target {
        &mut self.child
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::{os::windows::process::CommandExt, time::{Duration, Instant}};

    #[test]
    fn closing_the_job_stops_a_running_worker() {
        let mut child = ManagedChild::spawn(
            Command::new("ping.exe").args(["-n", "60", "127.0.0.1"]).creation_flags(0x08000000),
        ).unwrap();
        assert!(child.try_wait().unwrap().is_none());
        child.close_job();
        let deadline = Instant::now() + Duration::from_secs(5);
        loop {
            if child.try_wait().unwrap().is_some() {
                break;
            }
            assert!(Instant::now() < deadline, "the job did not terminate the worker");
            std::thread::sleep(Duration::from_millis(20));
        }
    }
}
