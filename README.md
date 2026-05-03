# Pi Architect Mode Extension

Architect Mode is a Pi coding agent extension that adds a structured thinking gate before implementation work. It classifies incoming prompts, runs a progressive Socratic design flow for architectural work, asks the model to critique the design, generates architecture options, and only then unlocks normal implementation.

## Install

From git:

```bash
pi install git:github.com/chrisetheridge/pi-extension-architect
```

From this local checkout:

```bash
npm install
pi install ./ -l
```

Pi clones git packages, runs `npm install` when `package.json` is present, then loads the resources declared in the `pi` manifest.

## Commands

- `/architect <task>` starts the Socratic architecture flow manually.
- `/architect disable` disables the extension until you re-enable it.
- `/architect enable` restores the extension after it has been disabled.
- `/skip-architect` remains a session-level alias for disabling the gate.
- `/unlock` clears a stuck lock and allows tools again.

## Configuration

Create `.pi/architect/config.json` in the active project:

```json
{
  "classifierModel": "openai:gpt-4o-mini",
  "architectModel": "openai:gpt-4.1",
  "autoTriggerAmbiguous": false,
  "savePlans": true,
  "prompts": {
    "classifier": "./.pi/architect/prompts/classifier.md",
    "review": "Critique this design for {{originalPrompt}}:\n\n{{answers}}",
    "options": "./.pi/architect/prompts/options.md"
  }
}
```

Model values may be either `provider:modelId` or a plain model id. If `architectModel` is omitted, the current Pi-selected model is used. If the classifier model is unavailable, the extension falls back to conservative keyword heuristics.

Prompt overrides are optional. Each value under `prompts` may be either a raw prompt template string or a path-like string to a Markdown file. Path-like values include strings ending in `.md`, absolute paths, `~`, `./`, or `../`; relative paths resolve from the active project directory. If a prompt file cannot be read, Architect Mode warns and falls back to its built-in prompt.

Supported template variables:

- `classifier`: `{{prompt}}`, `{{repoContext}}`
- `review`: `{{originalPrompt}}`, `{{answers}}`
- `options`: `{{originalPrompt}}`, `{{answers}}`, `{{reviewFeedback}}`, `{{followUpAnswers}}`

## What It Saves

After an approach is selected, the extension writes the decision record to:

```text
.pi/architect/PLAN-<slug>-<yyyy-mm-dd>.md
```

It also appends session state through `pi.appendEntry("architect-mode", ...)` so the selected plan can be restored from the session history.

When disabled, the extension stops classifying requests, stops injecting Architect Mode context, and stops blocking tools until you run `/architect enable`.
