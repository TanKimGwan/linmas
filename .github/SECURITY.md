# Security Policy

## Private vulnerability report

Please report security issues privately through GitHub Security Advisories for this repository.
If private reporting is unavailable, contact the maintainers privately before any public disclosure.
Do not open public issues for suspected vulnerabilities until maintainers confirm disclosure timing.

## Supported versions

Security fixes are provided for the current stable Linmas release published through the official GitHub Releases and npm package.

Users should reproduce suspected security issues against the current stable release before reporting when practical.

Older releases may receive fixes only at maintainer discretion. If an issue affects an older release, first check whether it remains reproducible on the current stable version.

## Security scope for Linmas

Please report issues involving:

- unsafe or insufficiently bounded skill instructions;
- harmful dual-use escalation beyond defensive or authorized use;
- package publishing or release workflow integrity;
- installer behavior that can overwrite, misroute, or expose user files;
- GitHub Actions permissions, token handling, or workflow trust boundaries;
- hardcoded secrets, secret exposure, or credential leakage;
- supply-chain integrity risks in packaged or published artifacts.

## Response expectations

- Acknowledgement target: within 3 business days
- Initial triage target: within 7 business days
- Remediation timeline: depends on severity and reproducibility

We may ask for reproduction details, affected versions, impact, and suggested mitigations.
Please keep reports private until a fix or coordinated disclosure window is agreed.
