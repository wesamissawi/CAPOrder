import React, { useEffect, useMemo, useState, useCallback } from "react";
import api from "../api";
import Card from "../components/Card";

// =============================================================================
// Rules view — edit the CAP/Sage code rules (the TRK→strip-dashes, NGK→NTK-for-O2
// logic) and the interchange part-number tables. JS (capRules.js) interprets
// this data; the AHK Sage-entry scripts consume the resulting sageCode.
// =============================================================================

const FIELDS = [
  { value: "linecode", label: "Line code" },
  { value: "partnumber", label: "Part number" },
  { value: "description", label: "Description" },
];
const fieldLabel = (f) => FIELDS.find((x) => x.value === f)?.label || f;

const CONDITION_TYPES = [
  { value: "eq", label: "equals" },
  { value: "startsWith", label: "starts with" },
  { value: "startsWithAny", label: "starts with any of" },
  { value: "contains", label: "contains" },
  { value: "containsAny", label: "contains any of" },
  { value: "interchangeHasKey", label: "interchange has a match" },
];

const TOKEN_KINDS = [
  { value: "lit", label: "Text" },
  { value: "var:linecode", label: "Line code" },
  { value: "var:partnumber", label: "Part number" },
  { value: "var:description", label: "Description" },
  { value: "interchange", label: "Interchange lookup" },
];

const TRANSFORMS = [
  { value: "", label: "as-is" },
  { value: "stripDash", label: "remove dashes" },
  { value: "substr", label: "drop leading chars" },
];

// ---- human-readable summaries -----------------------------------------------
function conditionSummary(c) {
  if (!c) return "";
  if (c.type === "interchangeHasKey") return `${c.file} has ${fieldLabel(c.key || "partnumber")}`;
  const opt = CONDITION_TYPES.find((x) => x.value === c.type)?.label || c.type;
  const val = Array.isArray(c.values) ? c.values.join(" / ") : c.value ?? "";
  return `${fieldLabel(c.field)} ${opt} “${val}”`;
}
function tokenSummary(t) {
  if (!t) return "";
  if (t.t === "lit") return `“${t.v}”`;
  if (t.t === "interchange") return `interchange(${t.file})`;
  if (t.t === "var") {
    let base = `<${fieldLabel(t.field).toLowerCase()}`;
    if (t.transform === "stripDash") base += " no-dashes";
    else if (t.transform === "substr") base += ` from ${t.start || 1}${t.trim ? " trimmed" : ""}`;
    return base + ">";
  }
  return "";
}
const tokensSummary = (arr) => (Array.isArray(arr) && arr.length ? arr.map(tokenSummary).join(" + ") : "");

// ---- blank templates --------------------------------------------------------
const blankCondition = () => ({ type: "eq", field: "linecode", value: "" });
const blankRule = () => ({
  id: `rule-${Date.now()}-${Math.floor(Math.random() * 1e4)}`,
  enabled: true,
  label: "New rule",
  conditions: [blankCondition()],
  code: [{ t: "var", field: "linecode" }, { t: "lit", v: " " }, { t: "var", field: "partnumber" }],
  description: null,
});

// token <-> "kind" select mapping
const tokenKind = (t) => (t.t === "var" ? `var:${t.field}` : t.t);
function tokenFromKind(kind) {
  if (kind === "lit") return { t: "lit", v: "" };
  if (kind === "interchange") return { t: "interchange", file: "trsToCAP.json", key: "partnumber" };
  if (kind.startsWith("var:")) return { t: "var", field: kind.slice(4) };
  return { t: "lit", v: "" };
}

// =============================================================================
export default function RulesView({ currentViewMeta }) {
  const [rules, setRules] = useState(null);
  const [meta, setMeta] = useState({ isDefault: true, source: "builtin", path: "", interchangeFiles: [] });
  const [dirty, setDirty] = useState(false);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [tab, setTab] = useState("logic");
  const [activeWh, setActiveWh] = useState("World");

  const load = useCallback(async () => {
    setLoading(true);
    setError("");
    try {
      const res = await api.getRules();
      if (!res?.ok) throw new Error(res?.error || "Failed to load rules.");
      setRules(res.rules);
      setMeta({ isDefault: res.isDefault, source: res.source, path: res.path, interchangeFiles: res.interchangeFiles || [] });
      setActiveWh((prev) => (res.rules.warehouses[prev] ? prev : Object.keys(res.rules.warehouses)[0] || "World"));
      setDirty(false);
    } catch (e) {
      setError(e?.message || "Failed to load rules.");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  const mutate = useCallback((fn) => {
    setRules((prev) => {
      const next = JSON.parse(JSON.stringify(prev));
      fn(next);
      return next;
    });
    setDirty(true);
    setNotice("");
  }, []);

  async function handleSave() {
    setSaving(true);
    setError("");
    setNotice("");
    try {
      const res = await api.saveRules(rules);
      if (!res?.ok) throw new Error(res?.error || "Save failed.");
      setDirty(false);
      setMeta((m) => ({ ...m, isDefault: false, source: "share", path: res.path }));
      setNotice("Rules saved. New orders and bublified parts will use them immediately.");
    } catch (e) {
      setError(e?.message || "Save failed.");
    } finally {
      setSaving(false);
    }
  }

  async function handleReset() {
    if (!(await api.confirm("Reset ALL rules to the shipped defaults? This overwrites your edited rules."))) return;
    setSaving(true);
    setError("");
    try {
      const res = await api.resetRulesDefaults();
      if (!res?.ok) throw new Error(res?.error || "Reset failed.");
      await load();
      setNotice("Rules reset to defaults.");
    } catch (e) {
      setError(e?.message || "Reset failed.");
    } finally {
      setSaving(false);
    }
  }

  if (loading) {
    return (
      <section className="space-y-4">
        <Card><div className="text-sm text-slate-500">Loading rules…</div></Card>
      </section>
    );
  }
  if (!rules) {
    return (
      <section className="space-y-4">
        <Card><div className="text-sm text-red-600">{error || "No rules loaded."}</div></Card>
      </section>
    );
  }

  const warehouses = Object.keys(rules.warehouses || {});

  return (
    <section className="space-y-4">
      <Card>
        <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
          <div>
            <p className="text-xl font-semibold text-slate-700">{currentViewMeta?.label || "Rules"}</p>
            <p className="text-sm text-slate-500">
              How supplier parts become CAP/Sage codes. Edited rules apply to new orders and bublified parts right away.
            </p>
            <p className="mt-1 text-xs text-slate-400">
              {meta.isDefault ? "Using shipped defaults" : "Using your edited rules"}
              {meta.path ? <> · <code className="text-indigo-600 break-all">{meta.path}</code></> : null}
            </p>
          </div>
          <div className="flex items-center gap-2">
            <button
              onClick={handleReset}
              disabled={saving}
              className="px-3 py-2 rounded-xl text-sm border border-slate-200 text-slate-600 hover:bg-slate-50 disabled:opacity-50"
            >
              Reset to defaults
            </button>
            <button
              onClick={handleSave}
              disabled={saving || !dirty}
              className="px-4 py-2 rounded-xl text-sm font-semibold text-white bg-indigo-600 hover:bg-indigo-700 disabled:opacity-40"
            >
              {saving ? "Saving…" : dirty ? "Save changes" : "Saved"}
            </button>
          </div>
        </div>
      </Card>

      {error && (
        <Card><div className="rounded-xl bg-red-50 border border-red-200 px-3 py-2 text-sm text-red-700">{error}</div></Card>
      )}
      {notice && (
        <Card><div className="rounded-xl bg-emerald-50 border border-emerald-200 px-3 py-2 text-sm text-emerald-700">{notice}</div></Card>
      )}

      <Tester interchangeFiles={meta.interchangeFiles} dirty={dirty} />

      <div className="flex gap-2">
        {[["logic", "Logic Rules"], ["interchange", "Interchange Tables"]].map(([id, label]) => (
          <button
            key={id}
            onClick={() => setTab(id)}
            className={`px-3 py-2 rounded-xl text-sm font-medium ${tab === id ? "bg-indigo-600 text-white" : "bg-white border border-slate-200 text-slate-600 hover:bg-slate-50"}`}
          >
            {label}
          </button>
        ))}
      </div>

      {tab === "logic" ? (
        <>
          <div className="flex flex-wrap gap-2">
            {warehouses.map((wh) => (
              <button
                key={wh}
                onClick={() => setActiveWh(wh)}
                className={`px-3 py-1.5 rounded-full text-sm ${activeWh === wh ? "bg-slate-800 text-white" : "bg-white border border-slate-200 text-slate-600 hover:bg-slate-50"}`}
              >
                {wh}
                <span className="ml-1.5 text-xs opacity-70">{(rules.warehouses[wh] || []).length}</span>
              </button>
            ))}
          </div>

          {rules.warehouses[activeWh] && (
            <>
              <WarehouseAliases warehouse={activeWh} rules={rules} mutate={mutate} />
              <WarehouseRules
                warehouse={activeWh}
                rules={rules.warehouses[activeWh]}
                interchangeFiles={meta.interchangeFiles}
                mutate={mutate}
              />
            </>
          )}

          <Card>
            <p className="text-xs text-slate-500">
              Rules are checked <strong>top to bottom</strong>; the first rule whose conditions all match wins. If none
              match, the code falls back to <code>&lt;line code&gt; &lt;part number&gt;</code>. Order matters — use the
              ▲▼ buttons to prioritize.
            </p>
          </Card>
        </>
      ) : (
        <InterchangeEditor files={meta.interchangeFiles} />
      )}
    </section>
  );
}

// ---- live tester ------------------------------------------------------------
function Tester({ interchangeFiles, dirty }) {
  const [wh, setWh] = useState("World");
  const [lc, setLc] = useState("");
  const [pn, setPn] = useState("");
  const [desc, setDesc] = useState("");
  const [out, setOut] = useState(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    let cancelled = false;
    const t = setTimeout(async () => {
      if (!lc && !pn) {
        setOut(null);
        return;
      }
      setBusy(true);
      try {
        const res = await api.testRule({ warehouse: wh, linecode: lc, partnumber: pn, description: desc });
        if (!cancelled) setOut(res);
      } catch {
        if (!cancelled) setOut({ ok: false, error: "test failed" });
      } finally {
        if (!cancelled) setBusy(false);
      }
    }, 250);
    return () => {
      cancelled = true;
      clearTimeout(t);
    };
  }, [wh, lc, pn, desc]);

  return (
    <Card>
      <div className="flex items-center justify-between mb-2">
        <p className="text-sm font-semibold text-slate-700">Test a part</p>
        {dirty && <span className="text-xs text-amber-600">Testing last-saved rules — save to test your edits</span>}
      </div>
      <div className="grid gap-2 md:grid-cols-4">
        <label className="flex flex-col gap-1 text-xs text-slate-600">
          Warehouse
          <input value={wh} onChange={(e) => setWh(e.target.value)}
            className="border rounded-xl px-3 py-2 text-sm bg-white" placeholder="World" />
        </label>
        <label className="flex flex-col gap-1 text-xs text-slate-600">
          Line code
          <input value={lc} onChange={(e) => setLc(e.target.value)}
            className="border rounded-xl px-3 py-2 text-sm bg-white" placeholder="TRK" />
        </label>
        <label className="flex flex-col gap-1 text-xs text-slate-600">
          Part number
          <input value={pn} onChange={(e) => setPn(e.target.value)}
            className="border rounded-xl px-3 py-2 text-sm bg-white" placeholder="GM-8314" />
        </label>
        <label className="flex flex-col gap-1 text-xs text-slate-600">
          Description
          <input value={desc} onChange={(e) => setDesc(e.target.value)}
            className="border rounded-xl px-3 py-2 text-sm bg-white" placeholder="Oxygen Sensor" />
        </label>
      </div>
      <div className="mt-3 rounded-xl bg-slate-50 border border-slate-200 px-3 py-2 text-sm">
        {out?.ok ? (
          <div className="flex flex-wrap items-center gap-x-6 gap-y-1">
            <span className="text-slate-500">Sage code:</span>
            <code className="text-base font-semibold text-indigo-700">{out.code || "—"}</code>
            <span className="text-slate-500">Description:</span>
            <span className="text-slate-700">{out.description || "—"}</span>
          </div>
        ) : out && !out.ok ? (
          <span className="text-red-600">{out.error || "Test failed."}</span>
        ) : (
          <span className="text-slate-400">{busy ? "Resolving…" : "Enter a line code and part number to see the resolved code."}</span>
        )}
      </div>
    </Card>
  );
}

// ---- one warehouse's rule list ----------------------------------------------
// Orders don't store the short key these rules are filed under — they store
// whatever the vendor's site calls the warehouse (World scrapes save "World
// Automotive Warehouse"). Without a matching alias the lookup finds nothing and
// every rule below is silently skipped, so this is worth surfacing next to them.
function WarehouseAliases({ warehouse, rules, mutate }) {
  const aliases = (rules.warehouseAliases && rules.warehouseAliases[warehouse]) || [];
  const [draft, setDraft] = useState(aliases.join("\n"));
  useEffect(() => {
    setDraft(aliases.join("\n"));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [warehouse, aliases.join("\n")]);

  function commit() {
    const next = draft
      .split("\n")
      .map((v) => v.trim())
      .filter(Boolean);
    if (next.join("\n") === aliases.join("\n")) return;
    mutate((d) => {
      if (!d.warehouseAliases) d.warehouseAliases = {};
      if (next.length) d.warehouseAliases[warehouse] = next;
      else delete d.warehouseAliases[warehouse];
    });
  }

  return (
    <Card>
      <div className="text-sm font-semibold text-slate-700">
        Warehouse names that use these “{warehouse}” rules
      </div>
      <p className="text-xs text-slate-500 mt-1 mb-2">
        An order matches these rules when its warehouse is exactly{" "}
        <span className="font-mono">{warehouse}</span>, or any name listed below. One per line.
        Orders store the vendor’s own wording — e.g. World orders save{" "}
        <span className="font-mono">World Automotive Warehouse</span> — and a name that isn’t
        listed here quietly falls through to the default code instead.
      </p>
      <textarea
        className="w-full border rounded-xl px-3 py-2 text-sm font-mono"
        rows={Math.max(2, aliases.length + 1)}
        value={draft}
        placeholder="(no extra names)"
        onChange={(e) => setDraft(e.target.value)}
        onBlur={commit}
      />
    </Card>
  );
}

function WarehouseRules({ warehouse, rules, interchangeFiles, mutate }) {
  const updateRule = (idx, next) =>
    mutate((d) => {
      d.warehouses[warehouse][idx] = next;
    });
  const removeRule = (idx) =>
    mutate((d) => {
      d.warehouses[warehouse].splice(idx, 1);
    });
  const moveRule = (idx, dir) =>
    mutate((d) => {
      const list = d.warehouses[warehouse];
      const j = idx + dir;
      if (j < 0 || j >= list.length) return;
      [list[idx], list[j]] = [list[j], list[idx]];
    });
  const addRule = () =>
    mutate((d) => {
      d.warehouses[warehouse].push(blankRule());
    });

  return (
    <div className="space-y-2">
      {rules.map((rule, idx) => (
        <RuleCard
          key={rule.id || idx}
          rule={rule}
          index={idx}
          total={rules.length}
          interchangeFiles={interchangeFiles}
          onChange={(next) => updateRule(idx, next)}
          onRemove={() => removeRule(idx)}
          onMove={(dir) => moveRule(idx, dir)}
        />
      ))}
      <button
        onClick={addRule}
        className="w-full rounded-2xl border-2 border-dashed border-slate-200 py-3 text-sm text-slate-500 hover:border-indigo-300 hover:text-indigo-600"
      >
        + Add rule to {warehouse}
      </button>
    </div>
  );
}

// ---- a single rule (collapsed summary + expandable editor) ------------------
function RuleCard({ rule, index, total, interchangeFiles, onChange, onRemove, onMove }) {
  const [open, setOpen] = useState(false);
  const set = (patch) => onChange({ ...rule, ...patch });

  const condsSummary = (rule.conditions || []).map(conditionSummary).join("  AND  ") || "always";
  const codeSummary = tokensSummary(rule.code) || "—";

  return (
    <div className={`rounded-2xl border bg-white ${rule.enabled === false ? "border-slate-200 opacity-60" : "border-slate-200"}`}>
      <div className="flex items-start gap-3 p-3">
        <div className="flex flex-col gap-1 pt-0.5">
          <button onClick={() => onMove(-1)} disabled={index === 0} className="text-slate-400 hover:text-slate-700 disabled:opacity-30 text-xs leading-none">▲</button>
          <button onClick={() => onMove(1)} disabled={index === total - 1} className="text-slate-400 hover:text-slate-700 disabled:opacity-30 text-xs leading-none">▼</button>
        </div>
        <button className="flex-1 text-left" onClick={() => setOpen((o) => !o)}>
          <div className="flex items-center gap-2">
            <span className="text-xs text-slate-400">#{index + 1}</span>
            <span className="text-sm font-medium text-slate-700">{rule.label || "(unnamed rule)"}</span>
          </div>
          <div className="mt-1 text-xs text-slate-500">
            <span className="text-slate-400">IF</span> {condsSummary} <span className="text-slate-400">→</span>{" "}
            <code className="text-indigo-600">{codeSummary}</code>
            {Array.isArray(rule.description) && rule.description.length ? (
              <> · <span className="text-slate-400">desc</span> <code className="text-slate-600">{tokensSummary(rule.description)}</code></>
            ) : null}
          </div>
        </button>
        <label className="flex items-center gap-1 text-xs text-slate-500 pt-0.5">
          <input type="checkbox" checked={rule.enabled !== false} onChange={(e) => set({ enabled: e.target.checked })} />
          on
        </label>
        <button onClick={() => setOpen((o) => !o)} className="text-xs text-indigo-600 hover:underline pt-0.5">
          {open ? "Close" : "Edit"}
        </button>
      </div>

      {open && (
        <div className="border-t border-slate-100 p-3 space-y-4">
          <label className="flex flex-col gap-1 text-xs text-slate-600 max-w-md">
            Rule name
            <input value={rule.label || ""} onChange={(e) => set({ label: e.target.value })}
              className="border rounded-xl px-3 py-2 text-sm bg-white" />
          </label>

          <ConditionsEditor
            conditions={rule.conditions || []}
            interchangeFiles={interchangeFiles}
            onChange={(conditions) => set({ conditions })}
          />

          <TokensEditor
            title="Output code (concatenated)"
            tokens={rule.code || []}
            interchangeFiles={interchangeFiles}
            onChange={(code) => set({ code })}
          />

          <div>
            <div className="flex items-center gap-2 mb-1">
              <span className="text-xs font-semibold text-slate-600">Description override</span>
              {Array.isArray(rule.description) && rule.description.length ? (
                <button onClick={() => set({ description: null })} className="text-xs text-slate-400 hover:text-red-600">remove</button>
              ) : (
                <button onClick={() => set({ description: [{ t: "var", field: "description" }] })} className="text-xs text-indigo-600 hover:underline">add</button>
              )}
            </div>
            {Array.isArray(rule.description) && rule.description.length ? (
              <TokensEditor
                title=""
                tokens={rule.description}
                interchangeFiles={interchangeFiles}
                onChange={(description) => set({ description })}
              />
            ) : (
              <p className="text-xs text-slate-400">Keeps the supplier's original description.</p>
            )}
          </div>

          <div className="flex justify-end">
            <button onClick={onRemove} className="text-xs text-red-600 hover:underline">Delete this rule</button>
          </div>
        </div>
      )}
    </div>
  );
}

// ---- conditions editor ------------------------------------------------------
function ConditionsEditor({ conditions, interchangeFiles, onChange }) {
  const update = (i, next) => onChange(conditions.map((c, j) => (j === i ? next : c)));
  const remove = (i) => onChange(conditions.filter((_, j) => j !== i));
  const add = () => onChange([...conditions, blankCondition()]);

  return (
    <div>
      <div className="text-xs font-semibold text-slate-600 mb-1">Conditions <span className="font-normal text-slate-400">(all must match)</span></div>
      <div className="space-y-2">
        {conditions.length === 0 && <p className="text-xs text-slate-400">No conditions — this rule always matches.</p>}
        {conditions.map((c, i) => (
          <div key={i} className="flex flex-wrap items-center gap-2">
            <select
              value={c.type}
              onChange={(e) => {
                const type = e.target.value;
                if (type === "interchangeHasKey") update(i, { type, file: interchangeFiles[0] || "trsToCAP.json", key: "partnumber" });
                else if (type === "startsWithAny" || type === "containsAny") update(i, { type, field: c.field || "partnumber", values: c.values || (c.value ? [c.value] : [""]) });
                else update(i, { type, field: c.field || "linecode", value: c.value || (c.values ? c.values[0] : "") });
              }}
              className="border rounded-lg px-2 py-1.5 text-xs bg-white"
            >
              {CONDITION_TYPES.map((t) => <option key={t.value} value={t.value}>{t.label}</option>)}
            </select>

            {c.type === "interchangeHasKey" ? (
              <>
                <select value={c.file} onChange={(e) => update(i, { ...c, file: e.target.value })} className="border rounded-lg px-2 py-1.5 text-xs bg-white">
                  {interchangeFiles.map((f) => <option key={f} value={f}>{f}</option>)}
                </select>
                <span className="text-xs text-slate-400">keyed by</span>
                <select value={c.key || "partnumber"} onChange={(e) => update(i, { ...c, key: e.target.value })} className="border rounded-lg px-2 py-1.5 text-xs bg-white">
                  {FIELDS.map((f) => <option key={f.value} value={f.value}>{f.label}</option>)}
                </select>
              </>
            ) : (
              <>
                <select value={c.field} onChange={(e) => update(i, { ...c, field: e.target.value })} className="border rounded-lg px-2 py-1.5 text-xs bg-white">
                  {FIELDS.map((f) => <option key={f.value} value={f.value}>{f.label}</option>)}
                </select>
                {c.type === "startsWithAny" || c.type === "containsAny" ? (
                  <input
                    value={(c.values || []).join(", ")}
                    onChange={(e) => update(i, { ...c, values: e.target.value.split(",").map((s) => s.trim()).filter(Boolean) })}
                    placeholder="CA, FT, DA"
                    className="border rounded-lg px-2 py-1.5 text-xs bg-white flex-1 min-w-[8rem]"
                  />
                ) : (
                  <input
                    value={c.value || ""}
                    onChange={(e) => update(i, { ...c, value: e.target.value })}
                    placeholder="value"
                    className="border rounded-lg px-2 py-1.5 text-xs bg-white flex-1 min-w-[8rem]"
                  />
                )}
              </>
            )}
            <button onClick={() => remove(i)} className="text-xs text-slate-300 hover:text-red-600">✕</button>
          </div>
        ))}
      </div>
      <button onClick={add} className="mt-2 text-xs text-indigo-600 hover:underline">+ condition</button>
    </div>
  );
}

// ---- tokens editor (for code and description) -------------------------------
function TokensEditor({ title, tokens, interchangeFiles, onChange }) {
  const update = (i, next) => onChange(tokens.map((t, j) => (j === i ? next : t)));
  const remove = (i) => onChange(tokens.filter((_, j) => j !== i));
  const add = () => onChange([...tokens, { t: "lit", v: "" }]);
  const move = (i, dir) => {
    const j = i + dir;
    if (j < 0 || j >= tokens.length) return;
    const copy = tokens.slice();
    [copy[i], copy[j]] = [copy[j], copy[i]];
    onChange(copy);
  };

  return (
    <div>
      {title ? <div className="text-xs font-semibold text-slate-600 mb-1">{title}</div> : null}
      <div className="space-y-2">
        {tokens.map((t, i) => (
          <div key={i} className="flex flex-wrap items-center gap-2">
            <div className="flex flex-col">
              <button onClick={() => move(i, -1)} disabled={i === 0} className="text-slate-300 hover:text-slate-600 disabled:opacity-30 text-[10px] leading-none">◀</button>
            </div>
            <select
              value={tokenKind(t)}
              onChange={(e) => update(i, tokenFromKind(e.target.value))}
              className="border rounded-lg px-2 py-1.5 text-xs bg-white"
            >
              {TOKEN_KINDS.map((k) => <option key={k.value} value={k.value}>{k.label}</option>)}
            </select>

            {t.t === "lit" && (
              <input value={t.v || ""} onChange={(e) => update(i, { ...t, v: e.target.value })} placeholder="e.g. “TRK ”"
                className="border rounded-lg px-2 py-1.5 text-xs bg-white flex-1 min-w-[6rem]" />
            )}
            {t.t === "var" && (
              <>
                <select value={t.transform || ""} onChange={(e) => {
                  const transform = e.target.value;
                  const next = { t: "var", field: t.field };
                  if (transform === "stripDash") next.transform = "stripDash";
                  else if (transform === "substr") { next.transform = "substr"; next.start = t.start || 2; next.trim = !!t.trim; }
                  update(i, next);
                }} className="border rounded-lg px-2 py-1.5 text-xs bg-white">
                  {TRANSFORMS.map((tr) => <option key={tr.value} value={tr.value}>{tr.label}</option>)}
                </select>
                {t.transform === "substr" && (
                  <>
                    <span className="text-[11px] text-slate-400">from char</span>
                    <input type="number" min="1" value={t.start || 1} onChange={(e) => update(i, { ...t, start: Number(e.target.value) || 1 })}
                      className="border rounded-lg px-2 py-1.5 text-xs bg-white w-16" />
                    <label className="text-[11px] text-slate-500 flex items-center gap-1">
                      <input type="checkbox" checked={!!t.trim} onChange={(e) => update(i, { ...t, trim: e.target.checked })} /> trim
                    </label>
                  </>
                )}
              </>
            )}
            {t.t === "interchange" && (
              <select value={t.file} onChange={(e) => update(i, { ...t, file: e.target.value })} className="border rounded-lg px-2 py-1.5 text-xs bg-white">
                {interchangeFiles.map((f) => <option key={f} value={f}>{f}</option>)}
              </select>
            )}
            <button onClick={() => remove(i)} className="text-xs text-slate-300 hover:text-red-600">✕</button>
          </div>
        ))}
      </div>
      <div className="mt-2 flex items-center gap-3">
        <button onClick={add} className="text-xs text-indigo-600 hover:underline">+ piece</button>
        <span className="text-[11px] text-slate-400">Preview: <code className="text-slate-600">{tokensSummary(tokens) || "—"}</code></span>
      </div>
    </div>
  );
}

// ---- interchange table editor ----------------------------------------------
function InterchangeEditor({ files }) {
  const [file, setFile] = useState(files[0] || "trsToCAP.json");
  const [rows, setRows] = useState([]); // [{key, value}]
  const [path, setPath] = useState("");
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [dirty, setDirty] = useState(false);
  const [query, setQuery] = useState("");
  const [msg, setMsg] = useState("");
  const [err, setErr] = useState("");

  const loadFile = useCallback(async (f) => {
    setLoading(true);
    setErr("");
    setMsg("");
    try {
      const res = await api.getInterchange(f);
      if (!res?.ok) throw new Error(res?.error || "Failed to load.");
      const entries = Object.entries(res.table || {}).map(([key, value]) => ({ key, value: String(value ?? "") }));
      entries.sort((a, b) => a.key.localeCompare(b.key));
      setRows(entries);
      setPath(res.path || "");
      setDirty(false);
    } catch (e) {
      setErr(e?.message || "Failed to load interchange.");
      setRows([]);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    loadFile(file);
  }, [file, loadFile]);

  const setRow = (i, patch) => {
    setRows((prev) => prev.map((r, j) => (j === i ? { ...r, ...patch } : r)));
    setDirty(true);
    setMsg("");
  };
  const addRow = () => {
    setRows((prev) => [{ key: "", value: "" }, ...prev]);
    setDirty(true);
  };
  const removeRow = (i) => {
    setRows((prev) => prev.filter((_, j) => j !== i));
    setDirty(true);
  };

  async function save() {
    setSaving(true);
    setErr("");
    setMsg("");
    try {
      const table = {};
      for (const r of rows) {
        const k = String(r.key).trim();
        if (k) table[k] = String(r.value ?? "");
      }
      const res = await api.saveInterchange(file, table);
      if (!res?.ok) throw new Error(res?.error || "Save failed.");
      setDirty(false);
      setMsg(`Saved ${res.count} mappings.`);
    } catch (e) {
      setErr(e?.message || "Save failed.");
    } finally {
      setSaving(false);
    }
  }

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return rows;
    return rows.filter((r) => r.key.toLowerCase().includes(q) || r.value.toLowerCase().includes(q));
  }, [rows, query]);

  return (
    <Card>
      <div className="flex flex-wrap items-center justify-between gap-2 mb-3">
        <div className="flex items-center gap-2">
          <select value={file} onChange={(e) => setFile(e.target.value)} className="border rounded-xl px-3 py-2 text-sm bg-white">
            {files.map((f) => <option key={f} value={f}>{f}</option>)}
          </select>
          <span className="text-xs text-slate-400">{rows.length} mappings</span>
        </div>
        <div className="flex items-center gap-2">
          <input value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Search…"
            className="border rounded-xl px-3 py-2 text-sm bg-white w-40" />
          <button onClick={addRow} className="px-3 py-2 rounded-xl text-sm border border-slate-200 text-slate-600 hover:bg-slate-50">+ Add</button>
          <button onClick={save} disabled={saving || !dirty}
            className="px-4 py-2 rounded-xl text-sm font-semibold text-white bg-indigo-600 hover:bg-indigo-700 disabled:opacity-40">
            {saving ? "Saving…" : dirty ? "Save" : "Saved"}
          </button>
        </div>
      </div>
      {path && <p className="text-xs text-slate-400 mb-2">File: <code className="text-indigo-600 break-all">{path}</code></p>}
      {err && <div className="rounded-xl bg-red-50 border border-red-200 px-3 py-2 text-sm text-red-700 mb-2">{err}</div>}
      {msg && <div className="rounded-xl bg-emerald-50 border border-emerald-200 px-3 py-2 text-sm text-emerald-700 mb-2">{msg}</div>}

      {loading ? (
        <div className="text-sm text-slate-500">Loading…</div>
      ) : (
        <div className="max-h-[28rem] overflow-y-auto rounded-xl border border-slate-100">
          <table className="w-full text-sm">
            <thead className="sticky top-0 bg-slate-50 text-xs text-slate-500">
              <tr>
                <th className="text-left font-medium px-3 py-2 w-1/2">Supplier part #</th>
                <th className="text-left font-medium px-3 py-2 w-1/2">CAP / Sage code</th>
                <th className="px-2 py-2 w-8" />
              </tr>
            </thead>
            <tbody>
              {filtered.map((r) => {
                const realIdx = rows.indexOf(r);
                return (
                  <tr key={realIdx} className="border-t border-slate-100">
                    <td className="px-3 py-1.5">
                      <input value={r.key} onChange={(e) => setRow(realIdx, { key: e.target.value })}
                        className="w-full border rounded-lg px-2 py-1.5 text-sm bg-white" />
                    </td>
                    <td className="px-3 py-1.5">
                      <input value={r.value} onChange={(e) => setRow(realIdx, { value: e.target.value })}
                        className="w-full border rounded-lg px-2 py-1.5 text-sm bg-white" />
                    </td>
                    <td className="px-2 py-1.5 text-center">
                      <button onClick={() => removeRow(realIdx)} className="text-slate-300 hover:text-red-600">✕</button>
                    </td>
                  </tr>
                );
              })}
              {filtered.length === 0 && (
                <tr><td colSpan={3} className="px-3 py-6 text-center text-sm text-slate-400">No mappings{query ? " match your search" : ""}.</td></tr>
              )}
            </tbody>
          </table>
        </div>
      )}
    </Card>
  );
}
