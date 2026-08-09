// Target entry: Terraria (FNA / Mono) — Instrument actions driven through the
// managed game state via the Mono embedding API exported by Terraria.bin.osx.
// Run:  flab run terraria
//
// Interceptor on Mono JIT prologues crashes the process under Rosetta x86_64, so
// cheats are applied from a timer loop instead of a Player.Update frame hook.
// Each tick re-fetches Main.player[Main.myPlayer] (the managed object can move under
// GC) and re-applies every enabled toggle.
//
// Commands run from the host console (await cmd("give 757 1")) or the game's own
// chat box: open chat in-game and type a slash command ("/heal", "/give 757 1").
// The managed chat send path can't be hooked (Interceptor crashes on Mono JIT),
// but the native SDL_PollEvent pump is safe: on the Enter that submits a
// "/"-prefixed line we blank Main.chatText synchronously — BEFORE Terraria's
// Update broadcasts it — so the command runs locally and is never seen by other
// players. pollChat() stays as a fallback for when the native hook is unavailable.

import { ok } from "../../lib/log.js";
import { createWindowsClrBridge } from "../../lib/clr/runtime.js";
import { TERRARIA_CLR_PAYLOAD_BASE64, TERRARIA_CLR_PAYLOAD_SHA256 } from "../../lib/clr/terraria-payload.js";
import { createMono } from "../../lib/mono/index.js";
import { recordingDescriptors, recordingRpcSurface } from "../../lib/recording.js";

const TICK_MS = 1;
const CHAT_PREFIX = "/";
const BIG_STACK = 99999;
const FREE_SLOTS = 50;
const WINDOWS_CLR = Process.platform === "windows";

const SDL_EVENT_KEY_DOWN = 0x300;
const SDLK_RETURN = 0x0d;
const SDLK_KP_ENTER = 0x40000058;
const SDL_EVENT_KEYCODE_OFFSET = 28;

const SDL_EVENT_MOUSE_BUTTON_UP = 0x402;
const SDL_MOUSE_BUTTON_RIGHT = 3;
const SDL_MOUSE_BUTTON_OFFSET = 24;

const TOGGLE_FEATURES: Record<string, string> = {
  god: "God", mana: "Mana", breath: "Breath", nokb: "NoKB",
  fly: "Fly", env: "Env", maxsummon: "MaxSummon", fastuse: "FastUse",
  maptp: "MapTP",
};

// Continuous mutations always start disabled on every runtime.
const DEFAULT_FEATURES: Record<string, boolean> = Object.fromEntries(
  Object.keys(TOGGLE_FEATURES).map((id) => [id, false]),
);

type FeatureId = keyof typeof TOGGLE_FEATURES & string;

interface CommandHost {
  log(line: string): void;
}

function create(host: CommandHost) {
    const mono = createMono({ target: "terraria", imageName: "Terraria" });

    const Main = mono.klass("Terraria", "Main");
    const Player = mono.klass("Terraria", "Player");
    const Item = mono.klass("Terraria", "Item");
    const Recipe = mono.klass("Terraria", "Recipe");
    const WorldMap = mono.klass("Terraria.Map", "WorldMap");

    const myPlayer = mono.staticField(Main, "myPlayer");
    const playerArr = mono.staticRef(Main, "player");
    const dayTime = mono.staticField(Main, "dayTime");
    const timeOfDay = mono.staticField(Main, "time");
    const chatText = mono.staticRefAccessor(Main, "chatText");
    const drawingChat = mono.staticField(Main, "drawingPlayerChat");
    const availableRecipe = mono.staticRef(Main, "availableRecipe");
    const numAvailableRecipes = mono.staticField(Main, "numAvailableRecipes");
    const numRecipes = mono.staticField(Recipe, "numRecipes");
    const newText = mono.methodFromName(Main, "NewText", 4);

    const mouseX = mono.staticField(Main, "mouseX");
    const mouseY = mono.staticField(Main, "mouseY");
    const mapFullscreen = mono.staticField(Main, "mapFullscreen");
    const screenPosition = mono.staticValue(Main, "screenPosition", 8);
    const mapFullscreenPos = mono.staticValue(Main, "mapFullscreenPos", 8);
    const mapFullscreenScale = mono.staticField(Main, "mapFullscreenScale");
    const screenWidth = mono.staticField(Main, "screenWidth");
    const screenHeight = mono.staticField(Main, "screenHeight");
    const maxTilesX = mono.staticField(Main, "maxTilesX");
    const maxTilesY = mono.staticField(Main, "maxTilesY");
    const refreshMap = mono.staticField(Main, "refreshMap");
    const mapRef = mono.staticRef(Main, "Map");

    const tileRef = mono.staticRef(Main, "tile");

    const f = {
      statLife: mono.field(Player, "statLife"),
      statLifeMax: mono.field(Player, "statLifeMax"),
      statLifeMax2: mono.field(Player, "statLifeMax2"),
      statMana: mono.field(Player, "statMana"),
      statManaMax: mono.field(Player, "statManaMax"),
      statManaMax2: mono.field(Player, "statManaMax2"),
      breath: mono.field(Player, "breath"),
      breathMax: mono.field(Player, "breathMax"),
      immune: mono.field(Player, "immune"),
      immuneTime: mono.field(Player, "immuneTime"),
      immuneNoBlink: mono.field(Player, "immuneNoBlink"),
      noKnockback: mono.field(Player, "noKnockback"),
      statDefense: mono.field(Player, "statDefense"),
      wingTime: mono.field(Player, "wingTime"),
      wingTimeMax: mono.field(Player, "wingTimeMax"),
      lavaImmune: mono.field(Player, "lavaImmune"),
      fireWalk: mono.field(Player, "fireWalk"),
      ignoreWater: mono.field(Player, "ignoreWater"),
      noFallDmg: mono.field(Player, "noFallDmg"),
      maxMinions: mono.field(Player, "maxMinions"),
      numMinions: mono.field(Player, "numMinions"),
      slotsMinions: mono.field(Player, "slotsMinions"),
      itemAnimation: mono.field(Player, "itemAnimation"),
      itemAnimationMax: mono.field(Player, "itemAnimationMax"),
      itemTime: mono.field(Player, "itemTime"),
      itemTimeMax: mono.field(Player, "itemTimeMax"),
      reuseDelay: mono.field(Player, "reuseDelay"),
      attackCD: mono.field(Player, "attackCD"),
      dead: mono.field(Player, "dead"),
      respawnTimer: mono.field(Player, "respawnTimer"),
      ghost: mono.field(Player, "ghost"),
      deadTime: mono.field(Player, "deadTime"),
      pvpDeath: mono.field(Player, "pvpDeath"),
      spawnX: mono.field(Player, "SpawnX"),
      spawnY: mono.field(Player, "SpawnY"),
    };
    const inventory = mono.refField(Player, "inventory");
    const posOff = mono.fieldOffsetOf(Player, "position");
    const wmTilesOff = mono.fieldOffsetOf(WorldMap, "_tiles");

    const wmMaxWOff = mono.fieldOffsetOf(WorldMap, "MaxWidth");
    const wmMaxHOff = mono.fieldOffsetOf(WorldMap, "MaxHeight");

    const itType = mono.field(Item, "type");
    const itStack = mono.field(Item, "stack");
    const itMaxStack = mono.field(Item, "maxStack");
    const itPrefix = mono.field(Item, "prefix");
    const setDefaults = mono.methodFromName(Item, "SetDefaults", 2);

    let features: Record<string, boolean> = { ...DEFAULT_FEATURES };
    let chatWasOpen = false;
    let chatBuffer = "";
    let chatHandledByStealth = false;
    const pendingEcho: string[] = [];
    const pendingCommands: string[] = [];
    const stealthDiag: string[] = [];
    let ticks = 0;
    let appliedTicks = 0;
    let lastTickError: string | null = null;

    function currentPlayer(): NativePointer {
      const arr = playerArr();
      if (arr.isNull()) return NULL;
      const idx = myPlayer.get();
      if (idx < 0 || idx >= mono.arrayLength(arr)) return NULL;
      return mono.refElement(arr, idx);
    }

    function applyToggles(p: NativePointer): void {
      if (Object.values(features).some(Boolean)) appliedTicks++;
      if (features.god) {
        f.statLife.write(p, Math.max(f.statLifeMax2.read(p), f.statLifeMax.read(p)));
        f.immune.write(p, 1);
        f.immuneTime.write(p, 120);
        f.immuneNoBlink.write(p, 1);
      }
      if (features.mana) f.statMana.write(p, Math.max(f.statManaMax2.read(p), f.statManaMax.read(p)));
      if (features.breath && f.breathMax.exists) f.breath.write(p, f.breathMax.read(p));
      if (features.nokb) f.noKnockback.write(p, 1);
      if (features.fly && f.wingTime.exists && f.wingTimeMax.exists) f.wingTime.write(p, f.wingTimeMax.read(p));
      if (features.env) {
        f.lavaImmune.write(p, 1);
        f.fireWalk.write(p, 1);
        f.ignoreWater.write(p, 1);
        f.noFallDmg.write(p, 1);
      }
      if (features.maxsummon && f.maxMinions.exists) {
        f.maxMinions.write(p, 99);
        f.slotsMinions.write(p, 0);
      }
      // FastUse: zero the reuse/cooldown so the game can re-trigger immediately,
      // and force itemTime to 0 so the use-action fires on the very next game tick.
      // We do NOT touch itemAnimationMax — that controls the visual swing and the
      // game gates the actual use-action on itemTime reaching itemTimeMax.
      if (features.fastuse) {
        f.reuseDelay.write(p, 0);
        f.attackCD.write(p, 0);
        if (f.itemTime.read(p) > 1) f.itemTime.write(p, 1);
      }
    }

    function pollChat(): void {
      const open = drawingChat.get() !== 0;
      if (open) {
        const t = mono.readString(chatText.get());
        if (t.length > 0) chatBuffer = t;
      } else if (chatWasOpen) {
        if (chatHandledByStealth) {
          chatHandledByStealth = false;
        } else if (chatBuffer.startsWith(CHAT_PREFIX)) {
          runChatCommand(chatBuffer.slice(CHAT_PREFIX.length));
        }
      }
      if (!open) chatBuffer = "";
      chatWasOpen = open;
    }

    // Called from SDL_PollEvent onLeave (game thread). When the player right-clicks
    // on the fullscreen map, teleport to the world coordinate under the cursor.
    // Uses Main.mouseX/Y (game's own mouse coords, DPI-correct) instead of raw SDL
    // event coords, which avoids the DPI scaling mismatch.
    function handleMapTPEvent(ev: NativePointer): void {
      if (!features.maptp || posOff < 0) return;
      if (ev.readU32() !== SDL_EVENT_MOUSE_BUTTON_UP) return;
      if (ev.add(SDL_MOUSE_BUTTON_OFFSET).readU8() !== SDL_MOUSE_BUTTON_RIGHT) return;
      if (mapFullscreen.get() === 0) return;
      const p = currentPlayer();
      if (p.isNull()) return;
      const mapPos = mapFullscreenPos.get();
      if (mapPos.isNull()) return;
      const mx = mouseX.get();
      const my = mouseY.get();
      const scale = mapFullscreenScale.get();
      if (scale <= 0) return;
      const sw = screenWidth.exists ? screenWidth.get() : 1920;
      const sh = screenHeight.exists ? screenHeight.get() : 1080;
      const worldX = mapPos.readFloat() + (mx - sw / 2) / scale;
      const worldY = mapPos.add(4).readFloat() + (my - sh / 2) / scale;
      const tileX = Math.round(worldX);
      const tileY = Math.round(worldY);
      p.add(posOff).writeFloat(tileX * 16);
      p.add(posOff + 4).writeFloat(tileY * 16);
      ingameEcho("map TP -> tile " + tileX + ", " + tileY);
    }

    function installChatStealth(): () => void {
      const poll = Module.findGlobalExportByName("SDL_PollEvent");
      if (poll === null) {
        stealthDiag.push("[stealth] SDL_PollEvent not found");
        return () => {};
      }
      let pendingEvent: NativePointer = NULL;
      let diagBudget = 8;
      const listener = Interceptor.attach(poll, {
        onEnter(args) { pendingEvent = args[0]; },
        onLeave(retval) {
          if (retval.toInt32() === 0 || pendingEvent.isNull()) return;
          flushEcho();
          const ev = pendingEvent;
          handleMapTPEvent(ev);
          if (ev.readU32() !== SDL_EVENT_KEY_DOWN) return;
          const key = ev.add(SDL_EVENT_KEYCODE_OFFSET).readU32();
          if (diagBudget > 0) {
            diagBudget--;
            stealthDiag.push("[stealth-diag] key=0x" + key.toString(16) + " chat=" + (drawingChat.get() !== 0));
          }
          if (key !== SDLK_RETURN && key !== SDLK_KP_ENTER) return;
          if (drawingChat.get() === 0) return;
          const strPtr = chatText.get();
          if (strPtr.isNull()) return;
          const text = mono.readString(strPtr);
          if (!text.startsWith(CHAT_PREFIX)) return;
          chatText.set(mono.newString(""));
          chatHandledByStealth = true;
          pendingCommands.push(text.slice(CHAT_PREFIX.length));
        },
      });
      stealthDiag.push("[stealth] active @ " + poll);
      return () => listener.detach();
    }

    function drainStealth(): void {
      while (stealthDiag.length) host.log(stealthDiag.shift()!);
      while (pendingCommands.length) runChatCommand(pendingCommands.shift()!);
    }

    function runChatCommand(submitted: string): void {
      const out = runCommand(submitted);
      host.log(CHAT_PREFIX + submitted);
      if (out) host.log(out);
      ingameEcho(out || "ok");
    }

    function ingameEcho(text: string): void {
      if (newText.isNull()) return;
      pendingEcho.push(text);
    }

    function flushEcho(): void {
      if (newText.isNull()) return;
      let msg: string | undefined;
      while ((msg = pendingEcho.shift()) !== undefined) {
        const s = mono.newString("[Instrument] " + msg);
        mono.invoke(newText, NULL, [s, byteBuf(120), byteBuf(230), byteBuf(120)]);
      }
    }

    function toggleFeature(id: string): string {
      if (!(id in TOGGLE_FEATURES)) return "unknown toggle '" + id + "'";
      const next = !features[id];
      features[id] = next;
      return TOGGLE_FEATURES[id] + " " + (next ? "ON" : "OFF");
    }

    function runCommand(raw: string): string {
      const parts = raw.trim().split(/\s+/);
      const cmd = (parts[0] || "").toLowerCase();
      switch (cmd) {
        case "": return "";
        case "help": return HELP;
        case "heal": return onPlayer((p) => { f.statLife.write(p, Math.max(f.statLifeMax2.read(p), f.statLifeMax.read(p))); return "HP restored"; });
        case "mana": return onPlayer((p) => { f.statMana.write(p, Math.max(f.statManaMax2.read(p), f.statManaMax.read(p))); return "mana restored"; });
        case "breath": return onPlayer((p) => { f.breath.write(p, f.breathMax.read(p)); return "breath restored"; });
        case "time": return cmdTime(parts[1]);
        case "give": return cmdGive(int(parts[1], -1), int(parts[2], 1), parts[3] != null ? int(parts[3], 0) : -1);
        case "dupe": return cmdDupe(int(parts[1], -1), int(parts[2], 1));
        case "tp": return cmdTp(num(parts[1]), num(parts[2]));
        case "tpc": return cmdTpc();
        case "summon": return cmdSummon(int(parts[1], 10));
        case "mapreveal": return cmdMapReveal();
        case "revive": return onPlayer((p) => {
          if (f.dead.exists) f.dead.write(p, 0);
          if (f.ghost.exists) f.ghost.write(p, 0);
          if (f.deadTime.exists) f.deadTime.write(p, 0);
          if (f.respawnTimer.exists) f.respawnTimer.write(p, 0);
          if (f.pvpDeath.exists) f.pvpDeath.write(p, 0);
          f.statLife.write(p, Math.max(f.statLifeMax2.read(p), f.statLifeMax.read(p)));
          f.statMana.write(p, Math.max(f.statManaMax2.read(p), f.statManaMax.read(p)));
          f.immune.write(p, 1);
          f.immuneTime.write(p, 120);
          return "revived in place";
        });
        case "respawn": return onPlayer((p) => {
          if (f.respawnTimer.exists) f.respawnTimer.write(p, 0);
          if (f.deadTime.exists) f.deadTime.write(p, 999999);
          // Let the game's UpdateDead see respawnTimer==0 and handle the actual
          // spawn: it will clear dead/ghost, move to SpawnX/Y, restore HP.
          return "respawning at spawn...";
        });
        case "stats": return statsText();
        case "god": return toggleFeature("god");
        case "infmana": return toggleFeature("mana");
        case "infbreath": return toggleFeature("breath");
        case "antikb": return toggleFeature("nokb");
        case "fly": return toggleFeature("fly");
        case "env": return toggleFeature("env");
        case "maxsummon": return toggleFeature("maxsummon");
        case "fastuse": return toggleFeature("fastuse");
        case "maptp": return toggleFeature("maptp");
        default:
          if (cmd in TOGGLE_FEATURES) return toggleFeature(cmd);
          return "unknown command '" + cmd + "' — try help";
      }
    }

    function onPlayer(act: (p: NativePointer) => string): string {
      const p = currentPlayer();
      return p.isNull() ? "no active player (load a world)" : act(p);
    }

    function cmdGive(type: number, stack: number, prefix: number): string {
      if (type < 0) return "usage: give <type> [stack] [prefix]";
      return onPlayer((p) => {
        const inv = inventory.read(p);
        const slot = freeSlot(inv);
        if (slot < 0) return "inventory full";
        const it = mono.refElement(inv, slot);
        fabricate(it, type);
        const ms = itMaxStack.read(it);
        itStack.write(it, Math.min(stack, ms > 0 ? ms : BIG_STACK));
        if (prefix >= 0 && itPrefix.exists) itPrefix.write(it, prefix);
        return "gave type " + type + " x" + itStack.read(it) + " -> slot " + slot;
      });
    }

    function cmdDupe(slot: number, count: number): string {
      if (slot < 0) return "usage: dupe <slot> [count]";
      return onPlayer((p) => {
        const inv = inventory.read(p);
        if (slot >= mono.arrayLength(inv)) return "slot out of range";
        const src = mono.refElement(inv, slot);
        if (src.isNull() || itType.read(src) === 0) return "slot " + slot + " is empty";
        const type = itType.read(src), stk = itStack.read(src);
        const pre = itPrefix.exists ? itPrefix.read(src) : -1;
        let made = 0;
        for (let c = 0; c < count; c++) {
          const fs = freeSlot(inv);
          if (fs < 0) break;
          const dst = mono.refElement(inv, fs);
          fabricate(dst, type);
          itStack.write(dst, stk);
          if (pre >= 0) itPrefix.write(dst, pre);
          made++;
        }
        return "duped slot " + slot + " (type " + type + ") x" + made;
      });
    }

    function cmdTp(tx: number, ty: number): string {
      if (posOff < 0) return "position field unavailable";
      if (!isFinite(tx) || !isFinite(ty)) return "usage: tp <tileX> <tileY>";
      return onPlayer((p) => {
        p.add(posOff).writeFloat(tx * 16);
        p.add(posOff + 4).writeFloat(ty * 16);
        return "teleported to tile (" + tx + ", " + ty + ")";
      });
    }

    function cmdTpc(): string {
      if (posOff < 0) return "position field unavailable";
      return onPlayer((p) => {
        const sp = screenPosition.get();
        if (sp.isNull()) return "screenPosition unavailable";
        const wx = sp.readFloat() + mouseX.get();
        const wy = sp.add(4).readFloat() + mouseY.get();
        p.add(posOff).writeFloat(wx);
        p.add(posOff + 4).writeFloat(wy);
        return "teleported to cursor (" + Math.round(wx / 16) + ", " + Math.round(wy / 16) + ")";
      });
    }

    function cmdSummon(count: number): string {
      if (!f.maxMinions.exists) return "maxMinions field unavailable";
      return onPlayer((p) => {
        f.maxMinions.write(p, count);
        f.slotsMinions.write(p, 0);
        return "maxMinions = " + count + " (slots reset to 0)";
      });
    }

    function cmdMapReveal(): string {
      if (wmTilesOff < 0 || wmMaxWOff < 0 || wmMaxHOff < 0) return "WorldMap fields unavailable";
      const wm = mapRef();
      if (wm.isNull()) return "Main.Map not loaded";
      const wmTiles = wm.add(wmTilesOff).readPointer();
      if (wmTiles.isNull()) return "_tiles array is null";
      const tileArr = tileRef();
      if (tileArr.isNull()) return "Main.tile not loaded";
      // The actual array dimensions come from WorldMap.MaxWidth/MaxHeight, NOT
      // Main.maxTilesX/Y (which exclude the border). Both Tile[,] and MapTile[,]
      // share the same [MaxWidth, MaxHeight] shape.
      const arrW = wm.add(wmMaxWOff).readS32();
      const arrH = wm.add(wmMaxHOff).readS32();
      if (arrW <= 0 || arrH <= 0) return "WorldMap dimensions not ready";
      // World tiles occupy [100..100+maxTilesX, 100..100+maxTilesY] inside the
      // bordered array. We iterate the full array — border tiles are air anyway.
      // Tile struct in array: 14 bytes. type @ +0 (U16), wall @ +2 (U16).
      // MapTile struct in array: 4 bytes. Type @ +0 (U16), Light @ +2 (U8).
      const wmData = wmTiles.add(0x20);
      const tileData = tileArr.add(0x20);
      let revealed = 0;
      for (let x = 0; x < arrW; x++) {
        for (let y = 0; y < arrH; y++) {
          const idx = x * arrH + y;
          const tileType = tileData.add(idx * 14).readU16();
          const wallType = tileData.add(idx * 14 + 2).readU16();
          if (tileType === 0 && wallType === 0) continue;
          const wmAddr = wmData.add(idx * 4);
          wmAddr.writeU16(tileType);
          wmAddr.add(2).writeU8(255);
          revealed++;
        }
      }
      if (refreshMap.exists) refreshMap.set(1);
      return "revealed " + revealed + " tiles (" + arrW + "x" + arrH + ")";
    }

    function cmdTime(which: string): string {
      switch ((which || "").toLowerCase()) {
        case "day": dayTime.set(1); timeOfDay.set(0); return "time: dawn";
        case "noon": dayTime.set(1); timeOfDay.set(27000); return "time: noon";
        case "night": dayTime.set(0); timeOfDay.set(0); return "time: dusk";
        case "mid": dayTime.set(0); timeOfDay.set(16200); return "time: midnight";
        default: return "usage: time day|noon|night|mid";
      }
    }

    function fabricate(it: NativePointer, type: number): void {
      const tb = Memory.alloc(4); tb.writeS32(type);
      const bb = byteBuf(0);
      mono.invoke(setDefaults, it, [tb, bb]);
    }

    function freeSlot(inv: NativePointer): number {
      const n = Math.min(FREE_SLOTS, mono.arrayLength(inv));
      for (let i = 0; i < n; i++) {
        const it = mono.refElement(inv, i);
        if (!it.isNull() && itType.read(it) === 0) return i;
      }
      return -1;
    }

    function statsText(): string {
      const p = currentPlayer();
      if (p.isNull()) return "no active player";
      const hp = f.statLife.read(p) + "/" + Math.max(f.statLifeMax2.read(p), f.statLifeMax.read(p));
      const mp = f.statMana.read(p) + "/" + Math.max(f.statManaMax2.read(p), f.statManaMax.read(p));
      const pos = posOff >= 0 ? Math.round(p.add(posOff).readFloat() / 16) + "," + Math.round(p.add(posOff + 4).readFloat() / 16) : "?";
      const summons = f.maxMinions.exists ? " | Summons " + f.numMinions.read(p) + "/" + f.maxMinions.read(p) : "";
      return "HP " + hp + " | Mana " + mp + " | Def " + f.statDefense.read(p) + " | Pos " + pos + summons + " | Active: " + activeList();
    }

    function playerSnapshot(): Record<string, unknown> {
      const p = currentPlayer();
      if (p.isNull()) {
        return { initialized: true, activePlayer: false, features: { ...features }, ticks, appliedTicks, lastTickError };
      }
      const read = (field: typeof f.statLife): number | null => field.exists ? field.read(p) : null;
      return {
        initialized: true,
        activePlayer: true,
        player: p.toString(),
        life: { current: read(f.statLife), max: Math.max(read(f.statLifeMax) ?? 0, read(f.statLifeMax2) ?? 0) },
        mana: { current: read(f.statMana), max: Math.max(read(f.statManaMax) ?? 0, read(f.statManaMax2) ?? 0) },
        breath: { current: read(f.breath), max: read(f.breathMax) },
        defense: read(f.statDefense),
        immune: read(f.immune) !== 0,
        immuneTime: read(f.immuneTime),
        noKnockback: read(f.noKnockback) !== 0,
        wing: { current: read(f.wingTime), max: read(f.wingTimeMax) },
        environment: {
          lavaImmune: read(f.lavaImmune) !== 0,
          fireWalk: read(f.fireWalk) !== 0,
          ignoreWater: read(f.ignoreWater) !== 0,
          noFallDamage: read(f.noFallDmg) !== 0,
        },
        summons: { current: read(f.numMinions), max: read(f.maxMinions), slots: read(f.slotsMinions) },
        position: posOff < 0 ? null : {
          x: p.add(posOff).readFloat(),
          y: p.add(posOff + 4).readFloat(),
          tileX: Math.round(p.add(posOff).readFloat() / 16),
          tileY: Math.round(p.add(posOff + 4).readFloat() / 16),
        },
        world: { day: dayTime.get() !== 0, time: timeOfDay.get() },
        features: { ...features },
        ticks,
        appliedTicks,
        lastTickError,
      };
    }

    function activeList(): string {
      const on: string[] = [];
      for (const id in TOGGLE_FEATURES) if (features[id]) on.push(TOGGLE_FEATURES[id]);
      return on.length ? on.join(", ") : "(none)";
    }

    const removeStealth = installChatStealth();

    const timer = setInterval(() => {
      try {
        ticks++;
        const p = currentPlayer();
        if (!p.isNull()) applyToggles(p);
        pollChat();
        drainStealth();
        lastTickError = null;
      } catch (error) {
        lastTickError = error instanceof Error ? error.message : String(error);
      }
    }, TICK_MS);

    ok("Terraria Instrument ready — cmd('help') or in-game chat with / prefix");

    let disposed = false;
    return {
      run(raw: string): string { return runCommand(raw); },
      setFeature(id: FeatureId, on: boolean): string {
        if (!(id in TOGGLE_FEATURES)) throw new Error(`unknown feature ${JSON.stringify(id)}`);
        features[id] = !!on;
        return TOGGLE_FEATURES[id] + " " + (features[id] ? "ON" : "OFF");
      },
      state(): Record<string, unknown> {
        return { initialized: true, enabled: Object.keys(TOGGLE_FEATURES).filter((id) => features[id]), ticks, appliedTicks, lastTickError, clean: disposed };
      },
      snapshot(): Record<string, unknown> { return playerSnapshot(); },
      dispose(): void {
        if (disposed) return;
        disposed = true;
        for (const id of Object.keys(features)) features[id] = false;
        removeStealth();
        clearInterval(timer);
      },
    };
}

interface TerrariaInstrument {
  run(raw: string): string;
  setFeature(id: FeatureId, on: boolean): string;
  state(): Record<string, unknown>;
  snapshot(): Record<string, unknown>;
  dispose(): unknown;
}

function createWindows(host: CommandHost): TerrariaInstrument {
  const bridge = createWindowsClrBridge({
    assemblyBase64: TERRARIA_CLR_PAYLOAD_BASE64,
    fileName: `flab-terraria-${TERRARIA_CLR_PAYLOAD_SHA256.slice(0, 12)}.dll`,
    typeName: "Flab.TerrariaBridge",
    resultVariable: "FLAB_TERRARIA_RESULT",
  });
  const call = (request: Record<string, unknown>): Record<string, unknown> => {
    const result = bridge.execute(JSON.stringify(request));
    if (!result || typeof result !== "object" || Array.isArray(result)) throw new Error("CLR bridge returned a non-object result");
    const record = result as Record<string, unknown>;
    if (record.ok === false) throw new Error(String(record.error ?? "managed Terraria action failed"));
    return record;
  };
  const probe = call({ op: "probe" });
  host.log(`[clr] managed bridge ready — ${String(probe.assembly ?? "Terraria")}`);
  let disposed = false;
  return {
    run(raw: string): string {
      const result = call({ op: "cmd", raw });
      return typeof result.result === "string" ? result.result : JSON.stringify(result);
    },
    setFeature(id: FeatureId, on: boolean): string {
      const result = call({ op: "set", id, on });
      return `${id} ${result.enabled === true ? "ON" : "OFF"}`;
    },
    state(): Record<string, unknown> { return call({ op: "state" }); },
    snapshot(): Record<string, unknown> { return call({ op: "snapshot" }); },
    dispose(): unknown {
      if (disposed) return { ok: true, stopped: false, clean: true };
      disposed = true;
      let result: unknown;
      try { result = call({ op: "dispose" }); }
      finally { bridge.dispose(); }
      return result;
    },
  };
}

let instrument: TerrariaInstrument | null = null;

function requireOffline(confirmed: boolean | undefined, action: string): void {
  if (confirmed !== true) throw new Error(`${action} requires offlineConfirmed=true`);
}

function activeInstrument(): TerrariaInstrument {
  instrument ??= WINDOWS_CLR ? createWindows({ log: (line) => ok(line) }) : create({ log: (line) => ok(line) });
  return instrument;
}

function disposeInstrument(): Record<string, unknown> {
  if (!instrument) return { ok: true, stopped: false, clean: true };
  const result = instrument.dispose();
  instrument = null;
  return result && typeof result === "object" && !Array.isArray(result)
    ? result as Record<string, unknown>
    : { ok: true, stopped: true, clean: true };
}

rpc.exports = {
  ...recordingRpcSurface(),
  modInfo() {
    return {
      game: "Terraria",
      runtime: WINDOWS_CLR ? ".NET CLR (Windows Steam 1.4.5+)" : "FNA / Mono",
      supported: true,
      adapter: WINDOWS_CLR ? "ICLRRuntimeHost + managed reflection payload" : "Mono embedding API",
      payload: WINDOWS_CLR ? { sha256: TERRARIA_CLR_PAYLOAD_SHA256, transport: "self-contained bundle -> default AppDomain" } : null,
      limitation: WINDOWS_CLR ? "map right-click teleport, cursor teleport, and full map reveal remain Mono-only; core player, inventory, teleport, time, and continuous assists use the CLR adapter" : null,
      safety: "Owned offline single-player only; all continuous features start disabled and initialize lazily",
      cleanup: "resetAll/dispose stops the timer and chat hook; one-shot world/inventory commands are labeled non-restoring",
    };
  },
  modState() {
    if (WINDOWS_CLR) return activeInstrument().state();
    return instrument?.state() ?? { initialized: false, enabled: [], clean: true };
  },
  playerSnapshot(): Record<string, unknown> {
    if (WINDOWS_CLR) return activeInstrument().snapshot();
    return instrument?.snapshot() ?? { initialized: false, activePlayer: false, features: {}, ticks: 0, appliedTicks: 0, lastTickError: null };
  },
  cmd(raw: string, offlineConfirmed?: boolean): string {
    const verb = raw.trim().split(/\s+/, 1)[0]?.toLowerCase() ?? "";
    if (!new Set(["help", "status", "stats"]).has(verb)) requireOffline(offlineConfirmed, "cmd");
    return activeInstrument().run(raw);
  },
  set(id: FeatureId, on: boolean, offlineConfirmed?: boolean): string {
    if (on) requireOffline(offlineConfirmed, "set");
    return activeInstrument().setFeature(id, !!on);
  },
  resetAll(): Record<string, unknown> { return disposeInstrument(); },
  dispose(): Record<string, unknown> { return disposeInstrument(); },
  __describe(): unknown {
    return [
      { name: "modInfo", label: "About this Instrument", category: "Start here", doc: "Runtime, offline safety boundary, and cleanup limitations", capabilities: ["instrument", "analysis"], effect: "read", returns: "json" },
      { name: "modState", label: "Show active features", category: "Start here", doc: "Lazy initialization, enabled feature ids, and clean state", capabilities: ["instrument", "analysis"], effect: "read", returns: "json" },
      { name: "playerSnapshot", label: "Read live player values", category: "Player", doc: "Structured HP, mana, breath, movement, environment, summon, position, world, and apply-tick readback", capabilities: ["instrument", "analysis"], effect: "read", returns: "json" },
      { name: "cmd", label: "Run a Terraria command", category: "Player", args: [{ name: "raw", type: "string", ui: { control: "input", label: "Command", placeholder: "heal | give 757 1 | time day" } }, { name: "offlineConfirmed", type: "boolean?", ui: { control: "checkbox", label: "Owned offline session" } }], doc: "Mutating commands require offlineConfirmed=true; one-shot effects may persist", capabilities: ["instrument"], effect: "control", returns: "scalar" },
      { name: "set", label: "Toggle continuous feature", category: "Training", args: [{ name: "id", type: "string", ui: { control: "select", label: "Feature", options: [{ label: "God mode", value: "god" }, { label: "Infinite mana", value: "mana" }, { label: "Infinite breath", value: "breath" }, { label: "No knockback", value: "nokb" }, { label: "Flight", value: "fly" }, { label: "Environment immunity", value: "env" }, { label: "Max summons", value: "maxsummon" }, { label: "Fast use", value: "fastuse" }, { label: "Map teleport", value: "maptp" }] } }, { name: "on", type: "boolean", ui: { control: "checkbox", label: "Enabled" } }, { name: "offlineConfirmed", type: "boolean?", ui: { control: "checkbox", label: "Owned offline session" } }], doc: "Enabling requires offlineConfirmed=true and starts the owned timer lazily", capabilities: ["instrument"], effect: "control", returns: "scalar", statusAction: "modState" },
      { name: "resetAll", label: "Stop continuous features", category: "Start here", doc: "Disable features and remove the timer/chat hook", capabilities: ["instrument"], effect: "control", returns: "json", statusAction: "modState" },
      { name: "dispose", label: "Dispose owned handles", category: "Start here", doc: "Automatic detach cleanup", capabilities: ["instrument"], effect: "control", returns: "json", statusAction: "modState" },
      ...recordingDescriptors(),
      { name: "__describe", doc: "This descriptor" },
    ];
  },
};

function byteBuf(value: number): NativePointer {
  const b = Memory.alloc(1);
  b.writeU8(value);
  return b;
}

function int(token: string | undefined, fallback: number): number {
  const n = parseInt(token ?? "", 10);
  return Number.isNaN(n) ? fallback : n;
}

function num(token: string | undefined): number {
  const n = parseFloat(token ?? "");
  return Number.isNaN(n) ? NaN : n;
}

const HELP = [
  "Terraria Instrument — type in this console or in-game chat (prefix /):",
  "  heal | mana | breath          restore HP / mana / breath",
  "  revive                        revive in place (clear death state, keep position)",
  "  respawn                       respawn at spawn point (like natural respawn)",
  "  time day|noon|night|mid       set time of day",
  "  give <type> [stack] [prefix]  spawn item id into a free slot",
  "  dupe <slot> [count]           duplicate the item in inventory <slot>",
  "  tp <tileX> <tileY>            teleport to tile coordinates",
  "  tpc                           teleport to cursor position",
  "  summon <count>                set max minions to <count> (default 10)",
  "  mapreveal                     reveal entire map",
  "  stats                         print HP/Mana/Def/Pos/Summons/toggles",
  "Toggles (/command to flip):",
  "  /god /infmana /infbreath /antikb /fly /env /maxsummon /fastuse /maptp",
  "In-game slash commands are intercepted locally and never broadcast to others.",
].join("\n");
