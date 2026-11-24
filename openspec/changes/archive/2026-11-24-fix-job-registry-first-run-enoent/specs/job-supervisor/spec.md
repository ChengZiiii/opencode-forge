## ADDED Requirements

### Requirement: Lifecycle initialization succeeds on a host without a jobs directory

The job supervisor's lifecycle initialization (survivor registry, rescan, fence,
exit cleanup) SHALL succeed on a host whose jobs directory does not exist yet —
the first run after an install, or any run after the OS temp directory was
cleaned. The survivor registry SHALL ensure the directory it lives in exists
before its first lock is taken, so that the first job of such a host is not
rejected with a missing-directory error and the fence and exit cleanup are
installed as on any other host.

#### Scenario: first job on a host with no jobs directory

- **WHEN** the first job is started on a host whose `<os-tmp>/opencode-forge/jobs` directory does not exist
- **THEN** the job runs and completes like any other job, and the lifecycle initialization reaches its end (registry rescanned, fence and exit cleanup installed)

#### Scenario: a registry opened in a directory that does not exist yet

- **WHEN** a survivor registry is created for a path whose directory does not exist and its first rescan runs
- **THEN** the rescan does not fail, the directory and the registry file exist afterwards, and no lock file is left behind

#### Scenario: a host whose jobs directory already exists

- **WHEN** the jobs directory already exists
- **THEN** behavior is unchanged
