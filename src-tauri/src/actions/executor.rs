use super::{Failure, Result, Target};
use serde::Serialize;
use sha2::{Digest, Sha256};
use std::path::PathBuf;

pub(super) const SYNTHETIC_MARKER: &str = "M11-ACTION-731902";
pub(super) const SYNTHETIC_COMMAND: &str = "echo M11-ACTION-731902";
pub(super) const SYNTHETIC_SCRIPT: &str = "Write-Output 'M11-ACTION-731902'";

#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
pub(super) struct ExecutionPlan {
    pub target: Target,
    pub executable: PathBuf,
    pub executable_sha256: String,
    pub args: Vec<String>,
    pub working_directory: PathBuf,
    pub content: Option<String>,
}
impl ExecutionPlan {
    pub fn fixed_arguments(target: Target) -> Vec<String> {
        let args: &[&str] = match target {
            Target::CommandPrompt => &["/D"],
            Target::Powershell => &["-NoProfile"],
            Target::SyntheticCommand => &["/D", "/C", SYNTHETIC_COMMAND],
            Target::SyntheticScript => &[
                "-NoProfile",
                "-NonInteractive",
                "-Command",
                SYNTHETIC_SCRIPT,
            ],
            _ => &[],
        };
        args.iter().map(|value| (*value).to_owned()).collect()
    }
    pub fn fixed_content(target: Target) -> Option<String> {
        match target {
            Target::SyntheticCommand => Some(SYNTHETIC_COMMAND.into()),
            Target::SyntheticScript => Some(SYNTHETIC_SCRIPT.into()),
            _ => None,
        }
    }
    pub fn validate(&self) -> Result<()> {
        if self.args != Self::fixed_arguments(self.target)
            || self.content != Self::fixed_content(self.target)
            || !self.executable.is_absolute()
            || self.executable.parent() != Some(self.working_directory.as_path())
            || self.executable_sha256.len() != 64
            || !self
                .executable_sha256
                .bytes()
                .all(|value| value.is_ascii_hexdigit())
        {
            return Err(Failure::InvalidReference);
        }
        Ok(())
    }
}

pub(super) trait Executor: Send + Sync {
    fn prepare(&self, target: Target) -> Result<ExecutionPlan>;
    fn execute(&self, plan: &ExecutionPlan) -> Result<()>;
}
pub(super) struct ActionExecutor;
impl Executor for ActionExecutor {
    fn prepare(&self, target: Target) -> Result<ExecutionPlan> {
        #[cfg(windows)]
        {
            let executable = resolve(target)?;
            let mut file = locked_executable(&executable)?;
            let executable_sha256 = hash_file(&mut file)?;
            let working_directory = executable
                .parent()
                .ok_or(Failure::TargetNotFound)?
                .to_owned();
            Ok(ExecutionPlan {
                target,
                executable,
                executable_sha256,
                args: ExecutionPlan::fixed_arguments(target),
                working_directory,
                content: ExecutionPlan::fixed_content(target),
            })
        }
        #[cfg(not(windows))]
        {
            let _ = target;
            Err(Failure::Unsupported)
        }
    }
    fn execute(&self, plan: &ExecutionPlan) -> Result<()> {
        plan.validate()?;
        #[cfg(windows)]
        {
            use std::os::windows::process::CommandExt;
            // Resolve again, require the exact canonical path approved by the user,
            // then deny file writes/deletes until CreateProcess has loaded that identity.
            if resolve(plan.target)? != plan.executable {
                return Err(Failure::InvalidReference);
            }
            let mut executable_guard = locked_executable(&plan.executable)?;
            if hash_file(&mut executable_guard)? != plan.executable_sha256 {
                return Err(Failure::InvalidReference);
            }
            let mut process = std::process::Command::new(&plan.executable);
            for name in [
                "JEV_API_KEY",
                "TYPESAFE_API_KEY",
                "OPENAI_API_KEY",
                "GEMINI_API_KEY",
                "GOOGLE_API_KEY",
                "ANTHROPIC_API_KEY",
            ] {
                process.env_remove(name);
            }
            process
                .args(&plan.args)
                .current_dir(&plan.working_directory);
            let terminal = matches!(plan.target, Target::CommandPrompt | Target::Powershell);
            let synthetic = matches!(
                plan.target,
                Target::SyntheticCommand | Target::SyntheticScript
            );
            if terminal {
                process.creation_flags(0x0000_0010); // explicitly requested visible terminal
            } else if synthetic {
                process.creation_flags(0x0800_0000); // no extra helper window
                process
                    .stdin(std::process::Stdio::null())
                    .stdout(std::process::Stdio::piped())
                    .stderr(std::process::Stdio::piped());
            } else {
                process
                    .stdin(std::process::Stdio::null())
                    .stdout(std::process::Stdio::null())
                    .stderr(std::process::Stdio::null());
            }
            let mut child = process.spawn().map_err(|_| Failure::ExecutionFailed)?;
            drop(executable_guard);
            if synthetic {
                let deadline = std::time::Instant::now() + std::time::Duration::from_secs(10);
                loop {
                    match child.try_wait() {
                        Err(_) => {
                            let _ = child.kill();
                            let _ = child.wait();
                            return Err(Failure::ExecutionFailed);
                        }
                        Ok(Some(_)) => break,
                        Ok(None) if std::time::Instant::now() < deadline => {
                            std::thread::sleep(std::time::Duration::from_millis(20))
                        }
                        Ok(None) => {
                            let _ = child.kill();
                            let _ = child.wait();
                            return Err(Failure::ExecutionFailed);
                        }
                    }
                }
                let output = child
                    .wait_with_output()
                    .map_err(|_| Failure::ExecutionFailed)?;
                let stdout =
                    String::from_utf8(output.stdout).map_err(|_| Failure::ExecutionFailed)?;
                if !output.status.success()
                    || !output.stderr.is_empty()
                    || stdout.trim() != SYNTHETIC_MARKER
                {
                    return Err(Failure::ExecutionFailed);
                }
                Ok(())
            } else {
                Ok(())
            }
        }
        #[cfg(not(windows))]
        {
            Err(Failure::Unsupported)
        }
    }
}

#[cfg(windows)]
fn locked_executable(path: &std::path::Path) -> Result<std::fs::File> {
    use std::os::windows::fs::OpenOptionsExt;
    std::fs::OpenOptions::new()
        .read(true)
        .share_mode(1)
        .open(path)
        .map_err(|_| Failure::TargetNotFound)
}
#[cfg(windows)]
fn hash_file(file: &mut std::fs::File) -> Result<String> {
    use std::io::Read;
    let mut digest = Sha256::new();
    let mut buffer = [0u8; 65536];
    loop {
        let read = file
            .read(&mut buffer)
            .map_err(|_| Failure::TargetNotFound)?;
        if read == 0 {
            break;
        }
        digest.update(&buffer[..read]);
    }
    Ok(format!("{:x}", digest.finalize()))
}
#[cfg(windows)]
fn system_directory() -> Result<PathBuf> {
    // Query Windows, never search PATH or trust a SystemRoot environment override.
    #[link(name = "kernel32")]
    extern "system" {
        fn GetSystemDirectoryW(buffer: *mut u16, size: u32) -> u32;
    }
    let mut buffer = vec![0u16; 32768];
    let size = unsafe { GetSystemDirectoryW(buffer.as_mut_ptr(), buffer.len() as u32) } as usize;
    if size == 0 || size >= buffer.len() {
        return Err(Failure::TargetNotFound);
    }
    use std::os::windows::ffi::OsStringExt;
    Ok(PathBuf::from(std::ffi::OsString::from_wide(
        &buffer[..size],
    )))
}
#[cfg(windows)]
fn resolve(target: Target) -> Result<PathBuf> {
    let system = system_directory()?;
    let program_files = std::env::var_os("ProgramFiles").map(PathBuf::from);
    let program_files_x86 = std::env::var_os("ProgramFiles(x86)").map(PathBuf::from);
    let mut candidates = match target {
        Target::Notepad => vec![system.join("notepad.exe")],
        Target::Calculator => vec![system.join("calc.exe")],
        Target::CommandPrompt | Target::SyntheticCommand => vec![system.join("cmd.exe")],
        Target::Powershell | Target::SyntheticScript => {
            vec![system.join("WindowsPowerShell/v1.0/powershell.exe")]
        }
        Target::VisualStudioCode => {
            let mut paths = Vec::new();
            if let Some(root) = &program_files {
                paths.push(root.join("Microsoft VS Code/Code.exe"));
            }
            if let Some(root) = std::env::var_os("LOCALAPPDATA").map(PathBuf::from) {
                paths.push(root.join("Programs/Microsoft VS Code/Code.exe"));
            }
            paths
        }
        Target::VisualStudio => {
            let mut paths = Vec::new();
            for root in [program_files, program_files_x86].into_iter().flatten() {
                for year in ["2022", "2019"] {
                    for edition in ["Community", "Professional", "Enterprise"] {
                        paths.push(
                            root.join("Microsoft Visual Studio")
                                .join(year)
                                .join(edition)
                                .join("Common7/IDE/devenv.exe"),
                        );
                    }
                }
            }
            paths
        }
    };
    candidates.retain(|path| path.is_absolute() && path.is_file());
    let mut resolved = candidates
        .into_iter()
        .map(std::fs::canonicalize)
        .collect::<std::io::Result<Vec<_>>>()
        .map_err(|_| Failure::TargetNotFound)?;
    resolved.sort();
    resolved.dedup();
    if resolved.len() != 1 {
        return Err(Failure::TargetNotFound);
    }
    Ok(resolved.remove(0))
}
