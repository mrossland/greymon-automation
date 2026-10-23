// Greymon Automation — GM-side helpers for player macros (Foundry V13/V14, D&D 5e 2024 rules).
//
// Player macros can't roll saves for monsters or change them. This module registers socketlib
// functions that run on the active GM's client instead:
//
//   const api = game.modules.get("greymon-automation")?.api;
//   await api.forceSave({ targetUuid, sourceTokenUuid, ability: "con", dc: 12, source: "Topple",
//                         onFail: { prone: true, pushFeet: 10 } });
//   await api.searingSmite({ targetUuid, casterName, dc: 13, dice: 1 });
//
// forceSave rolls the target's saving throw and, on a failure, applies Prone and/or pushes the
// target straight away from the source token (stopping at walls and other tokens). It returns
// { name, total, dc, success, prone, pushed, blocked, legendary }.
//
// searingSmite puts a "Searing Smite" effect on the target. At the start of each of the target's
// turns in combat, the GM client rolls the fire damage, applies it, and rolls the Constitution save;
// a success (or 1 minute passing) ends the effect.

const MODULE_ID = "greymon-automation";
let socket = null;

Hooks.once("socketlib.ready", () => {
  socket = socketlib.registerModule(MODULE_ID);
  socket.register("forceSave", gmForceSave);
  socket.register("searingSmite", gmSearingSmite);
});

Hooks.once("ready", () => {
  const module = game.modules.get(MODULE_ID);
  module.api = {
    version: module.version,
    ready: () => !!socket && !!game.users.activeGM,
    forceSave: (args) => runAsGM("forceSave", args),
    searingSmite: (args) => runAsGM("searingSmite", args),
  };
});

async function runAsGM(name, args) {
  if (!socket) throw new Error("Greymon Automation: socketlib is not ready.");
  if (!game.users.activeGM) throw new Error("Greymon Automation: no GM is connected.");
  return socket.executeAsGM(name, args);
}

// ---------------------------------------------------------------------------------------------
// Saving throws
// ---------------------------------------------------------------------------------------------

async function rollSave(actor, ability, dc, flavor) {
  let rolls;
  if (typeof actor.rollSavingThrow === "function") {
    rolls = await actor.rollSavingThrow({ ability, target: dc }, { configure: false }, { data: { flavor } });
  } else {
    rolls = [await actor.rollAbilitySave(ability, { targetValue: dc, fastForward: true, flavor })];
  }
  const roll = Array.isArray(rolls) ? rolls[0] : rolls;
  return roll?.total ?? null;
}

async function gmForceSave({ targetUuid, sourceTokenUuid, ability, dc, source, onFail = {} }) {
  const tokenDoc = await fromUuid(targetUuid);
  const actor = tokenDoc?.actor;
  if (!actor) throw new Error("Greymon Automation: target not found.");
  const label = CONFIG.DND5E.abilities?.[ability]?.label ?? ability;
  const flavor = `${source}: ${label} saving throw (DC ${dc})`;
  const total = await rollSave(actor, ability, dc, flavor);
  const success = total != null && total >= dc;
  const result = {
    name: tokenDoc.name,
    total,
    dc,
    success,
    prone: false,
    pushed: 0,
    blocked: false,
    legendary: (actor.system.resources?.legres?.max ?? 0) > 0,
  };
  if (success || total == null) return result;

  if (onFail.pushFeet && sourceTokenUuid) {
    const sourceDoc = await fromUuid(sourceTokenUuid);
    if (sourceDoc) Object.assign(result, await pushAway(tokenDoc, sourceDoc, onFail.pushFeet));
  }
  if (onFail.prone) {
    await actor.toggleStatusEffect("prone", { active: true });
    result.prone = true;
  }
  return result;
}

// ---------------------------------------------------------------------------------------------
// Push straight away from the source, one grid square at a time
// ---------------------------------------------------------------------------------------------

function tokenCenter(doc) {
  const size = canvas.grid.size;
  return { x: doc.x + (doc.width * size) / 2, y: doc.y + (doc.height * size) / 2 };
}

function wallBlocks(tokenObj, origin, dest) {
  try {
    if (typeof tokenObj?.checkCollision === "function") return !!tokenObj.checkCollision(dest, { origin, type: "move", mode: "any" });
  } catch (err) {
    console.warn(`${MODULE_ID} | checkCollision failed`, err);
  }
  try {
    const backend = CONFIG.Canvas.polygonBackends?.move;
    if (backend?.testCollision) return !!backend.testCollision(origin, dest, { type: "move", mode: "any" });
  } catch (err) {
    console.warn(`${MODULE_ID} | testCollision failed`, err);
  }
  return false;
}

function occupied(tokenDoc, x, y) {
  const size = canvas.grid.size;
  const w = tokenDoc.width * size;
  const h = tokenDoc.height * size;
  return canvas.tokens.placeables.some((t) => {
    const d = t.document;
    if (d.id === tokenDoc.id || d.hidden) return false;
    const tw = d.width * size;
    const th = d.height * size;
    return x < d.x + tw && x + w > d.x && y < d.y + th && y + h > d.y;
  });
}

async function pushAway(tokenDoc, sourceDoc, feet) {
  if (tokenDoc.parent?.id !== canvas.scene?.id) return { pushed: 0, blocked: true };
  const from = tokenCenter(sourceDoc);
  const to = tokenCenter(tokenDoc);
  const angle = Math.atan2(to.y - from.y, to.x - from.x);
  // Snap to one of the eight grid directions.
  const octant = Math.round(angle / (Math.PI / 4));
  const dx = Math.round(Math.cos(octant * (Math.PI / 4)));
  const dy = Math.round(Math.sin(octant * (Math.PI / 4)));
  const size = canvas.grid.size;
  const squares = Math.max(0, Math.floor(feet / (canvas.scene.grid.distance || 5)));
  let x = tokenDoc.x;
  let y = tokenDoc.y;
  let moved = 0;
  let blocked = false;
  for (let i = 0; i < squares; i++) {
    const nx = x + dx * size;
    const ny = y + dy * size;
    const origin = { x: x + (tokenDoc.width * size) / 2, y: y + (tokenDoc.height * size) / 2 };
    const dest = { x: nx + (tokenDoc.width * size) / 2, y: ny + (tokenDoc.height * size) / 2 };
    if (wallBlocks(tokenDoc.object, origin, dest) || occupied(tokenDoc, nx, ny)) {
      blocked = true;
      break;
    }
    x = nx;
    y = ny;
    moved++;
  }
  if (moved > 0) await tokenDoc.update({ x, y });
  return { pushed: moved * (canvas.scene.grid.distance || 5), blocked };
}

// ---------------------------------------------------------------------------------------------
// Searing Smite
// ---------------------------------------------------------------------------------------------

async function gmSearingSmite({ targetUuid, casterName, dc, dice = 1 }) {
  const tokenDoc = await fromUuid(targetUuid);
  const actor = tokenDoc?.actor;
  if (!actor) throw new Error("Greymon Automation: target not found.");
  const old = actor.effects.filter((e) => e.getFlag(MODULE_ID, "searing"));
  if (old.length) await actor.deleteEmbeddedDocuments("ActiveEffect", old.map((e) => e.id));
  const combat = game.combat;
  await actor.createEmbeddedDocuments("ActiveEffect", [
    {
      name: "Searing Smite",
      img: "icons/svg/fire.svg",
      description: `<p>Burning. At the start of each of its turns: ${dice}d6 fire damage, then a DC ${dc} Constitution save; a success ends it. Cast by ${casterName}.</p>`,
      duration: { seconds: 60, rounds: 10, startRound: combat?.round ?? null, startTurn: combat?.turn ?? null, combat: combat?.id ?? null },
      flags: { [MODULE_ID]: { searing: { dc, dice, casterName, startRound: combat?.round ?? null, combatId: combat?.id ?? null } } },
    },
  ]);
  return { name: tokenDoc.name, applied: true };
}

// At the start of each combatant's turn, the active GM resolves any Searing Smite on it.
Hooks.on("updateCombat", async (combat, changed) => {
  if (!game.users.activeGM?.isSelf) return;
  if (!("turn" in changed) && !("round" in changed)) return;
  const actor = combat.combatant?.actor;
  if (!actor) return;
  const effects = actor.effects.filter((e) => e.getFlag(MODULE_ID, "searing"));
  for (const effect of effects) {
    const data = effect.getFlag(MODULE_ID, "searing");
    const name = combat.combatant.token?.name ?? actor.name;
    // One minute is 10 rounds.
    if (data.combatId === combat.id && data.startRound != null && combat.round - data.startRound >= 10) {
      await effect.delete();
      await ChatMessage.create({ content: `<p><b>Searing Smite</b> on ${name} burns out after one minute.</p>` });
      continue;
    }
    const roll = new CONFIG.Dice.DamageRoll(`${data.dice}d6`, {}, { type: "fire", types: ["fire"] });
    await roll.evaluate();
    await roll.toMessage({ speaker: ChatMessage.getSpeaker({ actor }), flavor: `Searing Smite: ${name} burns (fire damage, applied automatically)` });
    try {
      await actor.applyDamage([{ value: roll.total, type: "fire" }]);
    } catch (err) {
      console.error(`${MODULE_ID} | applyDamage failed`, err);
      await actor.applyDamage(roll.total);
    }
    const total = await rollSave(actor, "con", data.dc, `Searing Smite: Constitution saving throw (DC ${data.dc})`);
    const success = total != null && total >= data.dc;
    if (success) await effect.delete();
    await ChatMessage.create({
      content: `<p><b>Searing Smite</b>: ${name} takes ${roll.total} fire damage, then rolls ${total ?? "?"} vs DC ${data.dc}. ${success ? "Success, the flames go out." : "Failure, it keeps burning."}</p>`,
    });
  }
});
