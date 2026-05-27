---
name: alice-selfie-fast
description: Use this skill when an external agent needs to generate an Alice selfie quickly through Alice's current selfie flow, or finish Alice selfie generation within 5 minutes. On trigger, immediately run the fast command without inspecting the repo first unless the command fails.
---

# Alice Selfie Fast

## Immediate Action

Do not explore the repo, read logs, inspect prompts, or plan first. Immediately run one low-quality API selfie:

```bash
node Skill/external/alice-selfie-fast/scripts/run-alice-selfie-fast.mjs "<short action>"
```

If the user did not provide an action, use:

```bash
node Skill/external/alice-selfie-fast/scripts/run-alice-selfie-fast.mjs "lean close to the camera, tilt her head slightly, with a shy expression"
```

Normal success response: report only the output file path and elapsed time from the command.

## Fixed Settings

The runner already forces one image, `gpt-image-2`, `768x1024`, `low`, `jpeg`, compression `45`, and a 120 second API timeout. Do not override these for normal fast selfie requests.

## Only If It Fails

- Missing key: ask for `OPENAI_API_KEY` or `SELFIE_IMAGE_API_KEY` in `/home/wyf98/Alice/.env`.
- API error: report the HTTP status and first useful error line.
- Timeout: report that the API did not return in the fast budget.
- Missing reference: report the missing path.
