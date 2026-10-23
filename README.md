# Greymon Automation

A small Foundry VTT module for the *Breaking the Green Circle* campaign (D&D 5e, 2024 rules, Foundry V13/V14).

Player macros can't roll saving throws for monsters or change them. This module uses [socketlib](https://github.com/manuelVo/foundryvtt-socketlib) to run those steps on the GM's client and send the result back to the player's macro.

## What it provides

```js
const api = game.modules.get("greymon-automation")?.api;
```

- `api.forceSave({ targetUuid, sourceTokenUuid, ability, dc, source, onFail: { prone, pushFeet } })` rolls the target's saving throw. On a failure it can push the target straight away from the source token (stopping at walls and other tokens) and give it the Prone condition. Returns `{ name, total, dc, success, prone, pushed, blocked, legendary }`.
- `api.searingSmite({ targetUuid, casterName, dc, dice })` puts a Searing Smite effect on the target. At the start of each of its turns in combat, the GM client rolls and applies the fire damage, then rolls the Constitution save; a success, or one minute passing, ends it.

Used by the Hammer of Faith macro (Valorian Hammerheart). A GM must be logged in.

## Install

Manifest URL: `https://github.com/mrossland/greymon-automation/releases/latest/download/module.json`

Requires socketlib.
