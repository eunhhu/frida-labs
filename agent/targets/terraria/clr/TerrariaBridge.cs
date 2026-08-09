using System;
using System.Collections;
using System.Collections.Generic;
using System.Diagnostics;
using System.Linq;
using System.Reflection;
using System.Threading;
using System.Web.Script.Serialization;

[assembly: AssemblyVersion("1.0.0.1")]
[assembly: AssemblyFileVersion("1.0.0.1")]

namespace Flab
{
    public static class TerrariaBridge
    {
        const string ResultVariable = "FLAB_TERRARIA_RESULT";
        static readonly object Sync = new object();
        static readonly JavaScriptSerializer Json = new JavaScriptSerializer();
        static readonly HashSet<string> Features = new HashSet<string>(StringComparer.OrdinalIgnoreCase);
        static readonly Dictionary<string, object> Captures = new Dictionary<string, object>();
        static Type MainType;
        static Type PlayerType;
        static Type ItemType;
        static object LastPlayer;
        static Timer Enforcement;
        static long Ticks;
        static long AppliedTicks;
        static string LastError;

        public static int Entry(string requestText)
        {
            object response;
            int code = 0;
            lock (Sync)
            {
                try
                {
                    Request request = Json.Deserialize<Request>(requestText ?? "{}");
                    response = Dispatch(request ?? new Request());
                }
                catch (Exception error)
                {
                    code = 1;
                    response = Obj("ok", false, "error", Unwrap(error).Message, "type", Unwrap(error).GetType().FullName);
                }
                string result = Json.Serialize(response);
                if (result.Length > 30000) result = Json.Serialize(Obj("ok", false, "error", "managed result exceeded 30000 characters"));
                Environment.SetEnvironmentVariable(ResultVariable, result, EnvironmentVariableTarget.Process);
            }
            return code;
        }

        static object Dispatch(Request request)
        {
            EnsureTypes();
            string op = (request.op ?? "state").ToLowerInvariant();
            if (op == "probe") return Probe();
            if (op == "snapshot") return Snapshot();
            if (op == "state") return State();
            if (op == "set") return SetFeature(request.id, request.on);
            if (op == "cmd") return RunCommand(request.raw ?? "");
            if (op == "dispose" || op == "reset") return DisposeManaged();
            throw new InvalidOperationException("unknown managed operation '" + op + "'");
        }

        static void EnsureTypes()
        {
            if (MainType != null && PlayerType != null) return;
            Assembly terraria = AppDomain.CurrentDomain.GetAssemblies().FirstOrDefault(a => a.GetName().Name == "Terraria");
            if (terraria == null) throw new InvalidOperationException("Terraria managed assembly is not loaded in the default AppDomain");
            MainType = terraria.GetType("Terraria.Main", true);
            PlayerType = terraria.GetType("Terraria.Player", true);
            ItemType = terraria.GetType("Terraria.Item", true);
        }

        static object Probe()
        {
            Assembly terraria = MainType.Assembly;
            return Obj(
                "ok", true,
                "runtime", Environment.Version.ToString(),
                "assembly", terraria.FullName,
                "bridgeVersion", typeof(TerrariaBridge).Assembly.GetName().Version.ToString(),
                "location", terraria.Location,
                "main", MainType.FullName,
                "player", PlayerType.FullName,
                "processId", Process.GetCurrentProcess().Id
            );
        }

        static object CurrentPlayer()
        {
            Array players = GetStatic("player") as Array;
            int index = Convert.ToInt32(GetStatic("myPlayer"));
            if (players == null || index < 0 || index >= players.Length) return null;
            return players.GetValue(index);
        }

        static object Snapshot()
        {
            object player = CurrentPlayer();
            if (player == null) return Obj("ok", true, "initialized", true, "activePlayer", false, "features", Features.ToArray(), "ticks", Ticks, "appliedTicks", AppliedTicks, "lastError", LastError);
            object position = Get(player, "position");
            double x = Component(position, "X");
            double y = Component(position, "Y");
            int lifeMax = Math.Max(Int(player, "statLifeMax"), Int(player, "statLifeMax2"));
            int manaMax = Math.Max(Int(player, "statManaMax"), Int(player, "statManaMax2"));
            return Obj(
                "ok", true,
                "initialized", true,
                "activePlayer", true,
                "life", Obj("current", Int(player, "statLife"), "max", lifeMax),
                "mana", Obj("current", Int(player, "statMana"), "max", manaMax),
                "breath", Obj("current", Int(player, "breath"), "max", Int(player, "breathMax")),
                "defense", Int(player, "statDefense"),
                "immune", Bool(player, "immune"),
                "immuneTime", Int(player, "immuneTime"),
                "noKnockback", Bool(player, "noKnockback"),
                "wing", Obj("current", Number(player, "wingTime"), "max", Number(player, "wingTimeMax")),
                "environment", Obj("lavaImmune", Bool(player, "lavaImmune"), "fireWalk", Bool(player, "fireWalk"), "ignoreWater", Bool(player, "ignoreWater"), "noFallDamage", Bool(player, "noFallDmg")),
                "summons", Obj("current", Int(player, "numMinions"), "max", Number(player, "maxMinions"), "slots", Number(player, "slotsMinions")),
                "position", Obj("x", x, "y", y, "tileX", Math.Round(x / 16.0), "tileY", Math.Round(y / 16.0)),
                "world", Obj("day", Convert.ToBoolean(GetStatic("dayTime")), "time", Convert.ToDouble(GetStatic("time"))),
                "inventory", InventorySnapshot(player),
                "features", Features.ToArray(),
                "ticks", Ticks,
                "appliedTicks", AppliedTicks,
                "lastError", LastError
            );
        }

        static object State()
        {
            return Obj("ok", true, "initialized", true, "enabled", Features.OrderBy(v => v).ToArray(), "timer", Enforcement != null, "ticks", Ticks, "appliedTicks", AppliedTicks, "lastError", LastError, "captures", Captures.Count, "clean", Enforcement == null && Features.Count == 0);
        }

        static object SetFeature(string id, bool on)
        {
            string key = (id ?? "").ToLowerInvariant();
            string[] allowed = { "god", "mana", "breath", "nokb", "fly", "env", "maxsummon", "fastuse" };
            if (!allowed.Contains(key)) throw new ArgumentException("unknown or unsupported Windows CLR feature '" + key + "'");
            object player = CurrentPlayer();
            if (on)
            {
                if (player == null) throw new InvalidOperationException("no active player (load an offline world)");
                CaptureFor(key, player);
                Features.Add(key);
                EnsureTimer();
                Apply(player);
            }
            else
            {
                Features.Remove(key);
                RestoreFor(key, player);
                if (Features.Count == 0) StopTimer();
            }
            return Obj("ok", true, "feature", key, "enabled", Features.Contains(key), "state", State());
        }

        static void EnsureTimer()
        {
            if (Enforcement == null) Enforcement = new Timer(Tick, null, 0, 10);
        }

        static void StopTimer()
        {
            Timer timer = Enforcement;
            Enforcement = null;
            if (timer != null) timer.Dispose();
        }

        static void Tick(object ignored)
        {
            if (!Monitor.TryEnter(Sync)) return;
            try
            {
                Ticks++;
                object player = CurrentPlayer();
                if (player != null)
                {
                    if (!Object.ReferenceEquals(player, LastPlayer))
                    {
                        LastPlayer = player;
                        Captures.Clear();
                        foreach (string feature in Features.ToArray()) CaptureFor(feature, player);
                    }
                    Apply(player);
                }
                LastError = null;
            }
            catch (Exception error) { LastError = Unwrap(error).Message; }
            finally { Monitor.Exit(Sync); }
        }

        static void Apply(object p)
        {
            if (Features.Count > 0) AppliedTicks++;
            if (Features.Contains("god"))
            {
                Set(p, "statLife", Math.Max(Int(p, "statLifeMax"), Int(p, "statLifeMax2")));
                Set(p, "immune", true); Set(p, "immuneTime", 120); SetIf(p, "immuneNoBlink", true);
            }
            if (Features.Contains("mana")) Set(p, "statMana", Math.Max(Int(p, "statManaMax"), Int(p, "statManaMax2")));
            if (Features.Contains("breath")) Set(p, "breath", Int(p, "breathMax"));
            if (Features.Contains("nokb")) Set(p, "noKnockback", true);
            if (Features.Contains("fly")) Set(p, "wingTime", Get(p, "wingTimeMax"));
            if (Features.Contains("env")) { Set(p, "lavaImmune", true); Set(p, "fireWalk", true); Set(p, "ignoreWater", true); Set(p, "noFallDmg", true); }
            if (Features.Contains("maxsummon")) { Set(p, "maxMinions", ConvertFor(Field(PlayerType, "maxMinions").FieldType, 99)); Set(p, "slotsMinions", ConvertFor(Field(PlayerType, "slotsMinions").FieldType, 0)); }
            if (Features.Contains("fastuse"))
            {
                SetIf(p, "reuseDelay", 0); SetIf(p, "attackCD", 0);
                if (IntIf(p, "itemTime", 0) > 1) SetIf(p, "itemTime", 1);
            }
        }

        static void CaptureFor(string feature, object p)
        {
            LastPlayer = p;
            if (feature == "god") Capture(p, "immune", "god");
            if (feature == "god") Capture(p, "immuneTime", "god");
            if (feature == "god") CaptureIf(p, "immuneNoBlink", "god");
            if (feature == "nokb") Capture(p, "noKnockback", "nokb");
            if (feature == "fly") Capture(p, "wingTime", "fly");
            if (feature == "env") foreach (string name in new[] { "lavaImmune", "fireWalk", "ignoreWater", "noFallDmg" }) Capture(p, name, "env");
            if (feature == "maxsummon") foreach (string name in new[] { "maxMinions", "slotsMinions" }) Capture(p, name, "maxsummon");
        }

        static void Capture(object p, string field, string feature)
        {
            string key = feature + ":" + field;
            if (!Captures.ContainsKey(key)) Captures[key] = Get(p, field);
        }

        static void CaptureIf(object p, string field, string feature)
        {
            if (Field(PlayerType, field, false) != null) Capture(p, field, feature);
        }

        static void RestoreFor(string feature, object p)
        {
            if (p == null || !Object.ReferenceEquals(p, LastPlayer)) return;
            string prefix = feature + ":";
            foreach (string key in Captures.Keys.Where(k => k.StartsWith(prefix, StringComparison.Ordinal)).ToArray())
            {
                Set(p, key.Substring(prefix.Length), Captures[key]);
                Captures.Remove(key);
            }
        }

        static object DisposeManaged()
        {
            object p = CurrentPlayer();
            foreach (string feature in Features.ToArray()) RestoreFor(feature, p);
            Features.Clear();
            Captures.Clear();
            StopTimer();
            LastPlayer = null;
            return Obj("ok", true, "stopped", true, "clean", true, "ticks", Ticks, "appliedTicks", AppliedTicks);
        }

        static object RunCommand(string raw)
        {
            string[] parts = (raw ?? "").Trim().Split(new[] { ' ' }, StringSplitOptions.RemoveEmptyEntries);
            string command = parts.Length == 0 ? "help" : parts[0].ToLowerInvariant();
            object p = CurrentPlayer();
            if (command == "help") return Obj("ok", true, "result", "heal | mana | breath | time day|noon|night|mid | give <type> [stack] [prefix] | clear <slot> | dupe <slot> [count] | tp <tileX> <tileY> | summon <count> | revive | respawn | stats");
            if (command == "stats") return Snapshot();
            if (p == null) throw new InvalidOperationException("no active player (load an offline world)");
            if (command == "heal") { Set(p, "statLife", Math.Max(Int(p, "statLifeMax"), Int(p, "statLifeMax2"))); return Result("HP restored"); }
            if (command == "mana") { Set(p, "statMana", Math.Max(Int(p, "statManaMax"), Int(p, "statManaMax2"))); return Result("mana restored"); }
            if (command == "breath") { Set(p, "breath", Int(p, "breathMax")); return Result("breath restored"); }
            if (command == "time") return SetTime(parts.Length > 1 ? parts[1] : "");
            if (command == "tp") return Teleport(p, ParseDouble(parts, 1), ParseDouble(parts, 2));
            if (command == "summon") { int count = ParseInt(parts, 1, 10); Set(p, "maxMinions", ConvertFor(Field(PlayerType, "maxMinions").FieldType, count)); Set(p, "slotsMinions", ConvertFor(Field(PlayerType, "slotsMinions").FieldType, 0)); return Result("maxMinions = " + count); }
            if (command == "revive") return Revive(p);
            if (command == "respawn") { SetIf(p, "respawnTimer", 0); SetIf(p, "deadTime", 999999); return Result("respawning at spawn"); }
            if (command == "give") return Give(p, ParseInt(parts, 1, -1), ParseInt(parts, 2, 1), ParseInt(parts, 3, -1));
            if (command == "clear") return Clear(p, ParseInt(parts, 1, -1));
            if (command == "dupe") return Dupe(p, ParseInt(parts, 1, -1), ParseInt(parts, 2, 1));
            throw new InvalidOperationException("unknown or unsupported Windows CLR command '" + command + "'");
        }

        static object SetTime(string which)
        {
            if (which == "day") { SetStatic("dayTime", true); SetStatic("time", 0.0); return Result("time: dawn"); }
            if (which == "noon") { SetStatic("dayTime", true); SetStatic("time", 27000.0); return Result("time: noon"); }
            if (which == "night") { SetStatic("dayTime", false); SetStatic("time", 0.0); return Result("time: dusk"); }
            if (which == "mid") { SetStatic("dayTime", false); SetStatic("time", 16200.0); return Result("time: midnight"); }
            throw new ArgumentException("usage: time day|noon|night|mid");
        }

        static object Teleport(object p, double tileX, double tileY)
        {
            if (Double.IsNaN(tileX) || Double.IsNaN(tileY)) throw new ArgumentException("usage: tp <tileX> <tileY>");
            FieldInfo field = Field(PlayerType, "position");
            object pos = field.GetValue(p);
            SetComponent(pos, "X", Convert.ToSingle(tileX * 16));
            SetComponent(pos, "Y", Convert.ToSingle(tileY * 16));
            field.SetValue(p, pos);
            return Result("teleported to tile (" + tileX + ", " + tileY + ")");
        }

        static object Revive(object p)
        {
            SetIf(p, "dead", false); SetIf(p, "ghost", false); SetIf(p, "deadTime", 0); SetIf(p, "respawnTimer", 0); SetIf(p, "pvpDeath", false);
            Set(p, "statLife", Math.Max(Int(p, "statLifeMax"), Int(p, "statLifeMax2")));
            Set(p, "statMana", Math.Max(Int(p, "statManaMax"), Int(p, "statManaMax2")));
            Set(p, "immune", true); Set(p, "immuneTime", 120);
            return Result("revived in place");
        }

        static object Give(object p, int type, int stack, int prefix)
        {
            if (type < 0) throw new ArgumentException("usage: give <type> [stack] [prefix]");
            Array inventory = Get(p, "inventory") as Array;
            int slot = FreeSlot(inventory);
            if (slot < 0) throw new InvalidOperationException("inventory full");
            object item = inventory.GetValue(slot);
            SetDefaults(item, type);
            int maxStack = Math.Max(1, Int(item, "maxStack"));
            Set(item, "stack", Math.Max(1, Math.Min(stack, maxStack)));
            if (prefix >= 0) SetIf(item, "prefix", ConvertFor(Field(ItemType, "prefix").FieldType, prefix));
            return Result("gave type " + type + " x" + Int(item, "stack") + " -> slot " + slot);
        }

        static object Dupe(object p, int slot, int count)
        {
            Array inventory = Get(p, "inventory") as Array;
            if (inventory == null || slot < 0 || slot >= inventory.Length) throw new ArgumentException("usage: dupe <slot> [count]");
            object source = inventory.GetValue(slot);
            int type = Int(source, "type");
            if (type == 0) throw new InvalidOperationException("slot " + slot + " is empty");
            int made = 0;
            for (int i = 0; i < Math.Max(1, count); i++)
            {
                int target = FreeSlot(inventory);
                if (target < 0) break;
                object item = inventory.GetValue(target);
                SetDefaults(item, type);
                Set(item, "stack", Int(source, "stack"));
                SetIf(item, "prefix", Get(source, "prefix"));
                made++;
            }
            return Result("duped slot " + slot + " x" + made);
        }

        static object Clear(object p, int slot)
        {
            Array inventory = Get(p, "inventory") as Array;
            if (inventory == null || slot < 0 || slot >= Math.Min(50, inventory.Length)) throw new ArgumentException("usage: clear <slot>");
            object item = inventory.GetValue(slot);
            int type = Int(item, "type");
            int stack = Int(item, "stack");
            SetDefaults(item, 0);
            return Result("cleared slot " + slot + " (type " + type + " x" + stack + ")");
        }

        static object[] InventorySnapshot(object player)
        {
            Array inventory = Get(player, "inventory") as Array;
            if (inventory == null) return new object[0];
            List<object> items = new List<object>();
            for (int slot = 0; slot < Math.Min(50, inventory.Length); slot++)
            {
                object item = inventory.GetValue(slot);
                int type = Int(item, "type");
                int stack = Int(item, "stack");
                if (type == 0 || stack <= 0) continue;
                items.Add(Obj("slot", slot, "type", type, "stack", stack, "prefix", IntIf(item, "prefix", 0)));
            }
            return items.ToArray();
        }

        static int FreeSlot(Array inventory)
        {
            if (inventory == null) return -1;
            for (int i = 0; i < Math.Min(50, inventory.Length); i++) if (Int(inventory.GetValue(i), "type") == 0) return i;
            return -1;
        }

        static void SetDefaults(object item, int type)
        {
            MethodInfo method = ItemType.GetMethods(InstanceFlags).Where(m => m.Name == "SetDefaults").Where(m => { ParameterInfo[] p = m.GetParameters(); return p.Length >= 1 && p[0].ParameterType == typeof(int); }).OrderBy(m => m.GetParameters().Length).FirstOrDefault();
            if (method == null) throw new MissingMethodException("Terraria.Item.SetDefaults(int, ...) not found");
            ParameterInfo[] parameters = method.GetParameters();
            object[] args = new object[parameters.Length];
            args[0] = type;
            for (int i = 1; i < args.Length; i++) args[i] = parameters[i].HasDefaultValue ? parameters[i].DefaultValue : (parameters[i].ParameterType.IsValueType ? Activator.CreateInstance(parameters[i].ParameterType) : null);
            method.Invoke(item, args);
        }

        static readonly BindingFlags StaticFlags = BindingFlags.Public | BindingFlags.NonPublic | BindingFlags.Static;
        static readonly BindingFlags InstanceFlags = BindingFlags.Public | BindingFlags.NonPublic | BindingFlags.Instance;
        static FieldInfo Field(Type type, string name, bool required = true)
        {
            FieldInfo field = type.GetField(name, StaticFlags | InstanceFlags);
            if (field == null && required) throw new MissingFieldException(type.FullName, name);
            return field;
        }
        static object GetStatic(string name) { return Field(MainType, name).GetValue(null); }
        static void SetStatic(string name, object value) { FieldInfo f = Field(MainType, name); f.SetValue(null, ConvertFor(f.FieldType, value)); }
        static object Get(object target, string name) { if (target == null) throw new NullReferenceException("cannot read " + name + " from null"); return Field(target.GetType(), name).GetValue(target); }
        static void Set(object target, string name, object value) { FieldInfo f = Field(target.GetType(), name); f.SetValue(target, ConvertFor(f.FieldType, value)); }
        static void SetIf(object target, string name, object value) { FieldInfo f = Field(target.GetType(), name, false); if (f != null) f.SetValue(target, ConvertFor(f.FieldType, value)); }
        static int Int(object target, string name) { return Convert.ToInt32(Get(target, name)); }
        static int IntIf(object target, string name, int fallback) { FieldInfo f = Field(target.GetType(), name, false); return f == null ? fallback : Convert.ToInt32(f.GetValue(target)); }
        static double Number(object target, string name) { return Convert.ToDouble(Get(target, name)); }
        static bool Bool(object target, string name) { return Convert.ToBoolean(Get(target, name)); }
        static object ConvertFor(Type type, object value) { if (value == null || type.IsInstanceOfType(value)) return value; if (type.IsEnum) return Enum.ToObject(type, value); return Convert.ChangeType(value, type); }
        static double Component(object value, string name) { FieldInfo f = value.GetType().GetField(name, InstanceFlags); return f != null ? Convert.ToDouble(f.GetValue(value)) : Convert.ToDouble(value.GetType().GetProperty(name, InstanceFlags).GetValue(value, null)); }
        static void SetComponent(object value, string name, object next) { FieldInfo f = value.GetType().GetField(name, InstanceFlags); if (f != null) f.SetValue(value, ConvertFor(f.FieldType, next)); else { PropertyInfo p = value.GetType().GetProperty(name, InstanceFlags); p.SetValue(value, ConvertFor(p.PropertyType, next), null); } }
        static Exception Unwrap(Exception error) { TargetInvocationException tie = error as TargetInvocationException; return tie != null && tie.InnerException != null ? tie.InnerException : error; }
        static Dictionary<string, object> Obj(params object[] values) { Dictionary<string, object> result = new Dictionary<string, object>(); for (int i = 0; i + 1 < values.Length; i += 2) result[Convert.ToString(values[i])] = values[i + 1]; return result; }
        static object Result(string value) { return Obj("ok", true, "result", value, "snapshot", Snapshot()); }
        static int ParseInt(string[] parts, int index, int fallback) { int value; return index < parts.Length && Int32.TryParse(parts[index], out value) ? value : fallback; }
        static double ParseDouble(string[] parts, int index) { double value; return index < parts.Length && Double.TryParse(parts[index], System.Globalization.NumberStyles.Float, System.Globalization.CultureInfo.InvariantCulture, out value) ? value : Double.NaN; }

        public sealed class Request
        {
            public string op { get; set; }
            public string id { get; set; }
            public bool on { get; set; }
            public string raw { get; set; }
        }
    }
}
