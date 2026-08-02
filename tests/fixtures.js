// Captured / representative ryzenadj outputs used by the parser tests.

// Successful `sudo -n ryzenadj --info` (Rembrandt laptop, ryzenadj 0.x).
export const INFO_OK = `CPU Family: Rembrandt
SMU BIOS Interface Version: 18
Version: v0.14.0
PM Table Version: 450005
|        Name         |   Value   |     Parameter      |
|---------------------|-----------|--------------------|
| STAPM LIMIT         |   25.000  | stapm-limit        |
| STAPM VALUE         |    9.882  |                    |
| PPT LIMIT FAST      |   30.000  | fast-limit         |
| PPT VALUE FAST      |   12.100  |                    |
| PPT LIMIT SLOW      |   28.000  | slow-limit         |
| PPT VALUE SLOW      |    9.885  |                    |
| StapmTimeConst      |  275.000  | stapm-time         |
| SlowPPTTimeConst    |   19.000  | slow-time          |
| PPT LIMIT APU       |   30.000  | apu-slow-limit     |
| PPT VALUE APU       |    9.885  |                    |
| TDC LIMIT VDD       |   55.000  | vrm-current        |
| TDC VALUE VDD       |    7.335  |                    |
| EDC LIMIT VDD       |  120.000  | vrmmax-current     |
| EDC VALUE VDD       |    9.436  |                    |
| THM LIMIT CORE      |   95.000  | tctl-temp          |
| THM VALUE CORE      |   60.250  |                    |
| STT LIMIT APU       |    0.000  | apu-skin-temp      |
| STT VALUE APU       |    0.000  |                    |
| CCLK Boost SETPOINT |    0.000  | power-saving /     |
`;

// Real capture from a Strix Point machine (ryzenadj v0.19.0): different
// value-column alignment, trailing space after the version, CCLK rows whose
// parameter column spans two lines.
export const INFO_STRIX = `detected compatible ryzen_smu kernel module
CPU Family: Strix Point
SMU BIOS Interface Version: 21
Version: v0.19.0
PM Table Version: 5d0009
|        Name         |   Value   |     Parameter      |
|---------------------|-----------|--------------------|
| STAPM LIMIT         |     8.000 | stapm-limit        |
| STAPM VALUE         |     4.232 |                    |
| PPT LIMIT FAST      |     8.000 | fast-limit         |
| PPT VALUE FAST      |     5.633 |                    |
| PPT LIMIT SLOW      |     5.000 | slow-limit         |
| PPT VALUE SLOW      |     4.674 |                    |
| StapmTimeConst      |   128.000 | stapm-time         |
| SlowPPTTimeConst    |   300.000 | slow-time          |
| PPT LIMIT APU       |    28.000 | apu-slow-limit     |
| PPT VALUE APU       |     0.000 |                    |
| TDC LIMIT VDD       |    54.000 | vrm-current        |
| TDC VALUE VDD       |     2.371 |                    |
| EDC LIMIT VDD       |    54.000 | vrmmax-current     |
| EDC VALUE VDD       |     2.371 |                    |
| THM LIMIT CORE      |    85.000 | tctl-temp          |
| THM VALUE CORE      |    47.049 |                    |
| STT LIMIT APU       |    85.000 | apu-skin-temp      |
| STT VALUE APU       |    47.554 |                    |
| STT LIMIT dGPU      |     0.000 | dgpu-skin-temp     |
| STT VALUE dGPU      |     0.000 |                    |
| CCLK Boost SETPOINT |     8.899 | power-saving /     |
| CCLK BUSY VALUE     |     0.005 | max-performance    |
`;

// `sudo -n …` without a NOPASSWD rule (captured on the dev machine).
export const SUDO_DENIED = {
    exitCode: 1,
    stdout: '',
    stderr: 'sudo: a password is required\n',
};

// ryzenadj run without root (captured on the dev machine).
export const NO_PERMISSION = {
    exitCode: 1,
    stdout: 'detected compatible ryzen_smu kernel module\n' +
        'Unable to get os_access Obj, check permission\n' +
        'Unable to init ryzenadj\n',
    stderr: '',
};

// Binary path that does not exist, run through sudo sh.
export const BINARY_MISSING = {
    exitCode: 127,
    stdout: '',
    stderr: 'sh: /usr/bin/ryzenadj: command not found\n',
};
