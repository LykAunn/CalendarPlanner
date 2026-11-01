'use strict';

var obsidian = require('obsidian');

function _interopDefaultLegacy (e) { return e && typeof e === 'object' && 'default' in e ? e : { 'default': e }; }

var obsidian__default = /*#__PURE__*/_interopDefaultLegacy(obsidian);

const DEFAULT_WEEK_FORMAT = "gggg-[W]ww";
const DEFAULT_WORDS_PER_DOT = 250;
const VIEW_TYPE_CALENDAR = "calendar";
const TRIGGER_ON_OPEN = "calendar:open";

const DEFAULT_DAILY_NOTE_FORMAT = "DD/MM/YYYY";
const DEFAULT_PLANNER_PATH = "planner.md";

// ============================================
// PLANNER PARSER - Reads from master planner.md
// ============================================

// Planner data engine. The master Markdown file remains the source of truth.
const PLANNER_META_PATTERN = /\s*\[(repeat|every|until|done|except|pid|time)::\s*([^\]]*)\]/gi;
const PLANNER_DATE_PATTERNS = [
    /^\*\*(\d{1,2}\/\d{1,2}\/\d{4}|\d{4}-\d{2}-\d{2})\*\*\s*$/,
    /^#{2,3}\s*(\d{1,2}\/\d{1,2}\/\d{4}|\d{4}-\d{2}-\d{2})\s*$/
];
const PLANNER_REPEAT_VALUES = ["none", "daily", "weekdays", "weekly", "monthly", "yearly"];

function plannerTimeToMinutes(str) {
    if (!str || !/^\d{1,2}:\d{2}$/.test(str)) return null;
    const [h, m] = str.split(":").map(Number);
    if (h > 23 || m > 59) return null;
    return h * 60 + m;
}
function plannerMinutesToTime(num) {
    return `${String(Math.floor(num / 60)).padStart(2, "0")}:${String(num % 60).padStart(2, "0")}`;
}
function plannerDateKey(date) {
    return window.moment(date).format("YYYY-MM-DD");
}
function plannerDateList(value) {
    return [...new Set(String(value || "").split(",").map(v => v.trim())
        .filter(v => /^\d{4}-\d{2}-\d{2}$/.test(v) && window.moment(v, "YYYY-MM-DD", true).isValid()))].sort();
}
function plannerDateOccurs(task, dateKey) {
    const moment = window.moment;
    if (!task.recurrence || task.recurrence === "none") return task.sourceDate === dateKey;
    const start = moment(task.sourceDate, "YYYY-MM-DD", true);
    const day = moment(dateKey, "YYYY-MM-DD", true);
    if (!start.isValid() || !day.isValid() || day.isBefore(start, "day")) return false;
    if (task.until && day.isAfter(moment(task.until, "YYYY-MM-DD", true), "day")) return false;
    if (task.exceptions.includes(dateKey)) return false;
    // The source date always represents the first occurrence, including a
    // weekend start for a Mon–Fri rule.
    if (day.isSame(start, "day")) return true;
    const every = Math.max(1, Math.min(365, task.every || 1));
    switch (task.recurrence) {
        case "daily": return day.diff(start, "days") % every === 0;
        case "weekdays": return day.isoWeekday() <= 5; // every is always 1 for weekdays.
        case "weekly": return day.isoWeekday() === start.isoWeekday() &&
            Math.floor(day.diff(start, "days") / 7) % every === 0;
        case "monthly": return day.date() === start.date() && day.diff(start, "months") % every === 0;
        case "yearly": return day.month() === start.month() && day.date() === start.date() &&
            day.diff(start, "years") % every === 0;
        default: return false;
    }
}

class PlannerParser {
    constructor(app) {
        this.app = app;
        this.plannerPath = DEFAULT_PLANNER_PATH;
        this.plannerData = {};
        this.allTasks = [];
        this.rangeEntries = [];
    }
    setPlannerPath(path) { this.plannerPath = path || DEFAULT_PLANNER_PATH; }
    normalizeDate(str) {
        const m = window.moment;
        const date = m(str, ["DD/MM/YYYY", "YYYY-MM-DD"], true);
        return date.isValid() ? date.format("YYYY-MM-DD") : null;
    }
    parseDateRange(text, contextYear) {
        const match = text.match(/\[(\d{1,2}\/\d{1,2}(?:\/\d{4})?)\s*[-–]\s*(\d{1,2}\/\d{1,2}(?:\/\d{4})?)\]/);
        if (!match) return null;
        const m = window.moment;
        const from = m(match[1].split("/").length === 2 ? `${match[1]}/${contextYear}` : match[1], "DD/MM/YYYY", true);
        const to = m(match[2].split("/").length === 2 ? `${match[2]}/${contextYear}` : match[2], "DD/MM/YYYY", true);
        if (!from.isValid() || !to.isValid() || to.isBefore(from, "day")) return null;
        return { fromDate: from.format("YYYY-MM-DD"), toDate: to.format("YYYY-MM-DD"), text: text.replace(match[0], "").trim() };
    }
    parseTaskLine(line, lineNum, dateKey) {
        const checkbox = line.match(/^\s*(?:(?:[-*]|\d+[.)])\s+)?\[([ xX])\]\s*(.*)$/);
        const bullet = !checkbox && line.match(/^\s*(?:[-*]|\d+[.)])\s+(.+)$/);
        if (!checkbox && !bullet) return null;
        let title = (checkbox ? checkbox[2] : bullet[1]).trim();
        if (!title) return null;
        const meta = {};
        title = title.replace(PLANNER_META_PATTERN, (_whole, key, value) => {
            meta[key.toLowerCase()] = value.trim();
            return "";
        }).trim();
        let startMinutes = null, endMinutes = null;
        const timedPrefix = title.match(/^(\d{1,2}:\d{2})(?:\s*[-–]\s*(\d{1,2}:\d{2}))?\s+(.+)$/);
        if (timedPrefix && plannerTimeToMinutes(timedPrefix[1]) !== null) {
            const a = plannerTimeToMinutes(timedPrefix[1]);
            const b = timedPrefix[2] ? plannerTimeToMinutes(timedPrefix[2]) : a + 60;
            if (b !== null && b > a && b <= 1440) {
                startMinutes = a; endMinutes = b; title = timedPrefix[3].trim();
            }
        } else if (meta.time) {
            const times = meta.time.match(/^(\d{1,2}:\d{2})\s*[-–]\s*(\d{1,2}:\d{2})$/);
            if (times) {
                const a = plannerTimeToMinutes(times[1]), b = plannerTimeToMinutes(times[2]);
                if (a !== null && b !== null && b > a) { startMinutes = a; endMinutes = b; }
            }
        }
        const range = this.parseDateRange(title, window.moment(dateKey, "YYYY-MM-DD").year());
        if (range) title = range.text;
        const recurrence = PLANNER_REPEAT_VALUES.includes(meta.repeat) ? meta.repeat : "none";
        const every = recurrence === "weekdays" ? 1 : Math.max(1, Math.min(365, parseInt(meta.every, 10) || 1));
        const until = this.normalizeDate(meta.until || "");
        const task = {
            text: title, completed: checkbox ? checkbox[1].toLowerCase() === "x" : false,
            line: lineNum, sourceLine: lineNum, sourceDate: dateKey, rawLine: line,
            id: meta.pid || null, recurrence, every, until,
            doneDates: plannerDateList(meta.done), exceptions: plannerDateList(meta.except),
            startMinutes, endMinutes, hasRange: !!range,
            fromDate: range ? range.fromDate : null, toDate: range ? range.toDate : null,
            isNote: false
        };
        return task;
    }
    parseContent(content) {
        const lines = content.split("\n");
        const data = {};
        const allTasks = [];
        let currentDate = null;
        for (let i = 0; i < lines.length; i++) {
            const line = lines[i];
            let nextDate = null;
            for (const pattern of PLANNER_DATE_PATTERNS) {
                const found = line.match(pattern);
                if (found) { nextDate = this.normalizeDate(found[1]); break; }
            }
            if (nextDate) {
                if (currentDate && data[currentDate]) data[currentDate].lineEnd = i - 1;
                currentDate = nextDate;
                if (!data[currentDate]) data[currentDate] = { tasks: [], lineStart: i, lineEnd: i };
                continue;
            }
            if (!currentDate) continue;
            const task = this.parseTaskLine(line, i, currentDate);
            if (task) { data[currentDate].tasks.push(task); allTasks.push(task); }
            else if (line.trim() && !/^\s*(?:#{1,6}\s|\*\*)/.test(line)) {
                data[currentDate].tasks.push({ text: line.trim(), isNote: true, line: i, sourceLine: i, sourceDate: currentDate, rawLine: line });
            }
        }
        if (currentDate && data[currentDate]) data[currentDate].lineEnd = lines.length - 1;
        this.plannerData = data;
        this.allTasks = allTasks;
        this.rangeEntries = allTasks.filter(t => t.hasRange);
        return data;
    }
    async parsePlanner() {
        const file = this.app.vault.getAbstractFileByPath(this.plannerPath);
        if (!(file instanceof obsidian.TFile)) return this.parseContent("");
        try { return this.parseContent(await this.app.vault.cachedRead(file)); }
        catch (err) { console.error("[Planner] Unable to read planner", err); return this.parseContent(""); }
    }
    getDataForDate(date) {
        const key = plannerDateKey(date);
        const base = this.plannerData[key] || { tasks: [] };
        const moment = window.moment;
        const target = moment(key, "YYYY-MM-DD", true);
        const tasks = [];
        // Include section notes; keep the physical source line for each task.
        for (const note of base.tasks.filter(t => t.isNote)) tasks.push({ ...note });
        for (const task of this.allTasks) {
            const from = task.hasRange && moment(task.fromDate, "YYYY-MM-DD", true);
            const to = task.hasRange && moment(task.toDate, "YYYY-MM-DD", true);
            const inRange = task.hasRange && target.isBetween(from, to, "day", "[]");
            const occurs = task.recurrence !== "none"
                ? plannerDateOccurs(task, key)
                : task.hasRange ? inRange : task.sourceDate === key;
            if (!occurs) continue;
            let position = null;
            if (inRange) position = key === task.fromDate ? "start" : key === task.toDate ? "end" : "middle";
            tasks.push({ ...task,
                originalCompleted: task.completed,
                occurrenceDate: key,
                completed: task.recurrence !== "none" && key !== task.sourceDate
                    ? task.doneDates.includes(key) : task.completed,
                isRecurringInstance: task.recurrence !== "none" && key !== task.sourceDate,
                isRangeEntry: task.hasRange && key !== task.sourceDate,
                rangePosition: position
            });
        }
        // Keep notes and tasks in their original order for the source date;
        // generated occurrences follow, ordered by their scheduled time.
        const physical = tasks.filter(t => t.sourceDate === key).sort((a, b) => a.line - b.line);
        const derived = tasks.filter(t => t.sourceDate !== key).sort((a, b) =>
            (a.startMinutes ?? 9999) - (b.startMinutes ?? 9999) || a.sourceDate.localeCompare(b.sourceDate));
        return { ...base, tasks: [...physical, ...derived], hasRangeEntries: tasks.some(t => t.hasRange) };
    }
    getRangeEntriesForDate(date) { return this.getDataForDate(date).tasks.filter(t => t.hasRange); }
    hasDataForDate(date) { return this.getDataForDate(date).tasks.length > 0; }
    getTaskCountForDate(date) { return this.getDataForDate(date).tasks.filter(t => !t.isNote).length; }
    getIncompleteTaskCountForDate(date) { return this.getDataForDate(date).tasks.filter(t => !t.isNote && !t.completed).length; }
    async mutate(mutator) {
        let file = this.app.vault.getAbstractFileByPath(this.plannerPath);
        if (!file) { await this.app.vault.create(this.plannerPath, ""); file = this.app.vault.getAbstractFileByPath(this.plannerPath); }
        if (!(file instanceof obsidian.TFile)) throw new Error(`Not a file: ${this.plannerPath}`);
        // process() avoids lost updates when multiple windows modify the same planner.
        if (typeof this.app.vault.process === "function") {
            await this.app.vault.process(file, data => mutator(data));
        } else {
            await this.app.vault.modify(file, mutator(await this.app.vault.read(file)));
        }
        await this.parsePlanner();
    }
    findLine(lines, task) {
        if (task.id) {
            const matches = lines.map((line, index) => line.includes(`[pid:: ${task.id}]`) ? index : -1)
                .filter(index => index >= 0);
            if (matches.length === 1) return matches[0];
            if (matches.length > 1) throw new Error("Duplicate task identifiers found. Please fix the planner file before editing.");
        }
        if (lines[task.sourceLine] === task.rawLine) return task.sourceLine;
        const matches = lines.map((line, index) => line === task.rawLine ? index : -1).filter(n => n !== -1);
        if (matches.length === 1) return matches[0];
        throw new Error("Task changed in the planner file. Reopen the day view and try again.");
    }
    makeTaskLine(model, original = null) {
        const title = String(model.text || "").replace(/[\r\n]+/g, " ").trim();
        if (!title) throw new Error("Task title is required.");
        const start = plannerTimeToMinutes(model.startTime);
        const end = plannerTimeToMinutes(model.endTime);
        if ((model.startTime || model.endTime) && (start === null || end === null || end <= start))
            throw new Error("Choose a valid start and end time, with the end after the start.");
        const from = this.normalizeDate(model.fromDate || "");
        const to = this.normalizeDate(model.toDate || "");
        if (model.multiDay && (!from || !to || to < from)) throw new Error("Choose a valid multi-day range.");
        const repeat = PLANNER_REPEAT_VALUES.includes(model.repeat) ? model.repeat : "none";
        if (model.multiDay && repeat !== "none") throw new Error("An entry cannot be both recurring and multi-day.");
        const every = repeat === "weekdays" ? 1 : Math.max(1, Math.min(365, Number(model.every) || 1));
        const until = this.normalizeDate(model.until || "");
        if (repeat !== "none" && model.until && !until) throw new Error("Repeat end date is invalid.");
        if (repeat !== "none" && until && until < (original?.sourceDate || model.dateKey))
            throw new Error("Repeat end date cannot precede the first occurrence.");
        const id = original?.id || `p${Date.now().toString(36)}${Math.random().toString(36).slice(2, 9)}`;
        const done = original?.doneDates || [];
        const except = original?.exceptions || [];
        const donePrefix = (original?.originalCompleted ?? original?.completed) ? "- [x] " : "- [ ] ";
        let line = donePrefix;
        if (start !== null) line += `${plannerMinutesToTime(start)} - ${plannerMinutesToTime(end)} `;
        line += title;
        if (model.multiDay) {
            const m = window.moment;
            line += ` [${m(from).format("DD/MM/YYYY")} - ${m(to).format("DD/MM/YYYY")}]`;
        }
        if (repeat !== "none") {
            line += ` [repeat:: ${repeat}]`;
            if (every > 1) line += ` [every:: ${every}]`;
            if (until) line += ` [until:: ${until}]`;
            if (done.length) line += ` [done:: ${done.join(", ")}]`;
            if (except.length) line += ` [except:: ${except.join(", ")}]`;
        }
        return line + ` [pid:: ${id}]`;
    }
    async saveTask(date, model, original = null) {
        const dateKey = plannerDateKey(date);
        const serialized = this.makeTaskLine({ ...model, dateKey }, original);
        await this.mutate(content => {
            const lines = content.split("\n");
            if (original) { lines[this.findLine(lines, original)] = serialized; return lines.join("\n"); }
            let insertAt = -1;
            let foundDate = false;
            for (let i = 0; i < lines.length; i++) {
                for (const p of PLANNER_DATE_PATTERNS) {
                    const found = lines[i].match(p);
                    if (found && this.normalizeDate(found[1]) === dateKey) { foundDate = true; insertAt = i + 1; }
                    else if (found && foundDate) { lines.splice(i, 0, serialized); return lines.join("\n"); }
                }
            }
            if (foundDate) { lines.splice(lines.length, 0, serialized); return lines.join("\n"); }
            const configuredFormat = get_store_value(settings).dateFormat === "YYYY-MM-DD" ? "YYYY-MM-DD" : "DD/MM/YYYY";
            const section = `**${window.moment(date).format(configuredFormat)}**`;
            return content.replace(/\s*$/, "") + `\n\n${section}\n${serialized}\n`;
        });
    }
    async addEntryForDate(date, text, fromDate = null, toDate = null) {
        const model = { text, dateKey: plannerDateKey(date), startTime: "", endTime: "", repeat: "none", multiDay: !!(fromDate && toDate),
            fromDate: fromDate && plannerDateKey(fromDate), toDate: toDate && plannerDateKey(toDate) };
        return this.saveTask(date, model);
    }
    async toggleTaskCompletion(date, indexOrTask) {
        const key = plannerDateKey(date);
        const task = typeof indexOrTask === "number" ? this.getDataForDate(date).tasks[indexOrTask] : indexOrTask;
        if (!task || task.isNote) return;
        await this.mutate(content => {
            const lines = content.split("\n");
            const index = this.findLine(lines, task);
            if (task.recurrence !== "none" && key !== task.sourceDate) {
                let next = lines[index].replace(/\s*\[done::\s*[^\]]*\]/i, "");
                const done = new Set(task.doneDates);
                if (done.has(key)) done.delete(key); else done.add(key);
                if (done.size) next += ` [done:: ${[...done].sort().join(", ")}]`;
                lines[index] = next;
            } else {
                let line = lines[index];
                if (/\[([ xX])\]/.test(line)) line = line.replace(/\[([ xX])\]/, task.completed ? "[ ]" : "[x]");
                else line = line.replace(/^(\s*)(?:\d+[.)]|[-*])\s+/, "$1- [x] ");
                lines[index] = line;
            }
            return lines.join("\n");
        });
    }
    async deleteTask(task, occurrenceDate = null, onlyOccurrence = false) {
        await this.mutate(content => {
            const lines = content.split("\n");
            const index = this.findLine(lines, task);
            const key = occurrenceDate && plannerDateKey(occurrenceDate);
            if (onlyOccurrence && task.recurrence !== "none" && key) {
                let line = lines[index].replace(/\s*\[except::\s*[^\]]*\]/i, "");
                const except = new Set(task.exceptions); except.add(key);
                line += ` [except:: ${[...except].sort().join(", ")}]`;
                lines[index] = line;
            } else lines.splice(index, 1);
            return lines.join("\n");
        });
    }
}

// Global planner instance
let plannerParser = null;

function getPlannerParser(app) {
    if (!plannerParser) {
        plannerParser = new PlannerParser(app);
    }
    return plannerParser;
}

// ============================================
// SVELTE RUNTIME (unchanged)
// ============================================

function noop$1() { }
function run$1(fn) {
    return fn();
}
function blank_object$1() {
    return Object.create(null);
}
function run_all$1(fns) {
    fns.forEach(run$1);
}
function is_function$1(thing) {
    return typeof thing === 'function';
}
function safe_not_equal$1(a, b) {
    return a != a ? b == b : a !== b || ((a && typeof a === 'object') || typeof a === 'function');
}
function not_equal$1(a, b) {
    return a != a ? b == b : a !== b;
}
function is_empty$1(obj) {
    return Object.keys(obj).length === 0;
}
function subscribe(store, ...callbacks) {
    if (store == null) {
        return noop$1;
    }
    const unsub = store.subscribe(...callbacks);
    return unsub.unsubscribe ? () => unsub.unsubscribe() : unsub;
}
function get_store_value(store) {
    let value;
    subscribe(store, _ => value = _)();
    return value;
}
function component_subscribe(component, store, callback) {
    component.$$.on_destroy.push(subscribe(store, callback));
}
function detach$1(node) {
    node.parentNode.removeChild(node);
}
function children$1(element) {
    return Array.from(element.childNodes);
}

let current_component$1;
function set_current_component$1(component) {
    current_component$1 = component;
}
function get_current_component$1() {
    if (!current_component$1)
        throw new Error('Function called outside component initialization');
    return current_component$1;
}
function onDestroy(fn) {
    get_current_component$1().$$.on_destroy.push(fn);
}

const dirty_components$1 = [];
const binding_callbacks$1 = [];
const render_callbacks$1 = [];
const flush_callbacks$1 = [];
const resolved_promise$1 = Promise.resolve();
let update_scheduled$1 = false;
function schedule_update$1() {
    if (!update_scheduled$1) {
        update_scheduled$1 = true;
        resolved_promise$1.then(flush$1);
    }
}
function add_render_callback$1(fn) {
    render_callbacks$1.push(fn);
}
function add_flush_callback(fn) {
    flush_callbacks$1.push(fn);
}
let flushing$1 = false;
const seen_callbacks$1 = new Set();
function flush$1() {
    if (flushing$1)
        return;
    flushing$1 = true;
    do {
        for (let i = 0; i < dirty_components$1.length; i += 1) {
            const component = dirty_components$1[i];
            set_current_component$1(component);
            update$1(component.$$);
        }
        set_current_component$1(null);
        dirty_components$1.length = 0;
        while (binding_callbacks$1.length)
            binding_callbacks$1.pop()();
        for (let i = 0; i < render_callbacks$1.length; i += 1) {
            const callback = render_callbacks$1[i];
            if (!seen_callbacks$1.has(callback)) {
                seen_callbacks$1.add(callback);
                callback();
            }
        }
        render_callbacks$1.length = 0;
    } while (dirty_components$1.length);
    while (flush_callbacks$1.length) {
        flush_callbacks$1.pop()();
    }
    update_scheduled$1 = false;
    flushing$1 = false;
    seen_callbacks$1.clear();
}
function update$1($$) {
    if ($$.fragment !== null) {
        $$.update();
        run_all$1($$.before_update);
        const dirty = $$.dirty;
        $$.dirty = [-1];
        $$.fragment && $$.fragment.p($$.ctx, dirty);
        $$.after_update.forEach(add_render_callback$1);
    }
}
const outroing$1 = new Set();
let outros$1;
function transition_in$1(block, local) {
    if (block && block.i) {
        outroing$1.delete(block);
        block.i(local);
    }
}
function transition_out$1(block, local, detach, callback) {
    if (block && block.o) {
        if (outroing$1.has(block))
            return;
        outroing$1.add(block);
        outros$1.c.push(() => {
            outroing$1.delete(block);
            if (callback) {
                if (detach)
                    block.d(1);
                callback();
            }
        });
        block.o(local);
    }
}

function bind(component, name, callback) {
    const index = component.$$.props[name];
    if (index !== undefined) {
        component.$$.bound[index] = callback;
        callback(component.$$.ctx[index]);
    }
}
function create_component$1(block) {
    block && block.c();
}
function mount_component$1(component, target, anchor, customElement) {
    const { fragment, on_mount, on_destroy, after_update } = component.$$;
    fragment && fragment.m(target, anchor);
    if (!customElement) {
        add_render_callback$1(() => {
            const new_on_destroy = on_mount.map(run$1).filter(is_function$1);
            if (on_destroy) {
                on_destroy.push(...new_on_destroy);
            }
            else {
                run_all$1(new_on_destroy);
            }
            component.$$.on_mount = [];
        });
    }
    after_update.forEach(add_render_callback$1);
}
function destroy_component$1(component, detaching) {
    const $$ = component.$$;
    if ($$.fragment !== null) {
        run_all$1($$.on_destroy);
        $$.fragment && $$.fragment.d(detaching);
        $$.on_destroy = $$.fragment = null;
        $$.ctx = [];
    }
}
function make_dirty$1(component, i) {
    if (component.$$.dirty[0] === -1) {
        dirty_components$1.push(component);
        schedule_update$1();
        component.$$.dirty.fill(0);
    }
    component.$$.dirty[(i / 31) | 0] |= (1 << (i % 31));
}
function init$1(component, options, instance, create_fragment, not_equal, props, dirty = [-1]) {
    const parent_component = current_component$1;
    set_current_component$1(component);
    const $$ = component.$$ = {
        fragment: null,
        ctx: null,
        props,
        update: noop$1,
        not_equal,
        bound: blank_object$1(),
        on_mount: [],
        on_destroy: [],
        on_disconnect: [],
        before_update: [],
        after_update: [],
        context: new Map(parent_component ? parent_component.$$.context : []),
        callbacks: blank_object$1(),
        dirty,
        skip_bound: false
    };
    let ready = false;
    $$.ctx = instance
        ? instance(component, options.props || {}, (i, ret, ...rest) => {
            const value = rest.length ? rest[0] : ret;
            if ($$.ctx && not_equal($$.ctx[i], $$.ctx[i] = value)) {
                if (!$$.skip_bound && $$.bound[i])
                    $$.bound[i](value);
                if (ready)
                    make_dirty$1(component, i);
            }
            return ret;
        })
        : [];
    $$.update();
    ready = true;
    run_all$1($$.before_update);
    $$.fragment = create_fragment ? create_fragment($$.ctx) : false;
    if (options.target) {
        if (options.hydrate) {
            const nodes = children$1(options.target);
            $$.fragment && $$.fragment.l(nodes);
            nodes.forEach(detach$1);
        }
        else {
            $$.fragment && $$.fragment.c();
        }
        if (options.intro)
            transition_in$1(component.$$.fragment);
        mount_component$1(component, options.target, options.anchor, options.customElement);
        flush$1();
    }
    set_current_component$1(parent_component);
}

class SvelteComponent$1 {
    $destroy() {
        destroy_component$1(this, 1);
        this.$destroy = noop$1;
    }
    $on(type, callback) {
        const callbacks = (this.$$.callbacks[type] || (this.$$.callbacks[type] = []));
        callbacks.push(callback);
        return () => {
            const index = callbacks.indexOf(callback);
            if (index !== -1)
                callbacks.splice(index, 1);
        };
    }
    $set($$props) {
        if (this.$$set && !is_empty$1($$props)) {
            this.$$.skip_bound = true;
            this.$$set($$props);
            this.$$.skip_bound = false;
        }
    }
}

const subscriber_queue = [];
function writable(value, start = noop$1) {
    let stop;
    const subscribers = [];
    function set(new_value) {
        if (safe_not_equal$1(value, new_value)) {
            value = new_value;
            if (stop) {
                const run_queue = !subscriber_queue.length;
                for (let i = 0; i < subscribers.length; i += 1) {
                    const s = subscribers[i];
                    s[1]();
                    subscriber_queue.push(s, value);
                }
                if (run_queue) {
                    for (let i = 0; i < subscriber_queue.length; i += 2) {
                        subscriber_queue[i][0](subscriber_queue[i + 1]);
                    }
                    subscriber_queue.length = 0;
                }
            }
        }
    }
    function update(fn) {
        set(fn(value));
    }
    function subscribe(run, invalidate = noop$1) {
        const subscriber = [run, invalidate];
        subscribers.push(subscriber);
        if (subscribers.length === 1) {
            stop = start(set) || noop$1;
        }
        run(value);
        return () => {
            const index = subscribers.indexOf(subscriber);
            if (index !== -1) {
                subscribers.splice(index, 1);
            }
            if (subscribers.length === 0) {
                stop();
                stop = null;
            }
        };
    }
    return { set, update, subscribe };
}

// ============================================
// SETTINGS
// ============================================

const weekdays$1 = [
    "sunday",
    "monday",
    "tuesday",
    "wednesday",
    "thursday",
    "friday",
    "saturday",
];

const defaultSettings = Object.freeze({
    shouldConfirmBeforeCreate: false,
    weekStart: "locale",
    wordsPerDot: DEFAULT_WORDS_PER_DOT,
    showWeeklyNote: false,
    localeOverride: "system-default",
    plannerPath: DEFAULT_PLANNER_PATH,
    dateFormat: "DD/MM/YYYY",
    maxEntriesPerDay: 3,
    dayStartHour: 6,
    dayEndHour: 23,
    timelineHourHeight: 76,
    defaultTaskMinutes: 60,
    plannerViewSpan: 1,
});

class CalendarSettingsTab extends obsidian.PluginSettingTab {
    constructor(app, plugin) {
        super(app, plugin);
        this.plugin = plugin;
    }
    display() {
        this.containerEl.empty();
        
        this.containerEl.createEl("h3", {
            text: "Planner Settings",
        });

        new obsidian.Setting(this.containerEl)
            .setName("Planner file path")
            .setDesc("Path to your master planner file (e.g., planner.md)")
            .addText((textfield) => {
                textfield.setPlaceholder(DEFAULT_PLANNER_PATH);
                textfield.setValue(this.plugin.options.plannerPath || DEFAULT_PLANNER_PATH);
                textfield.onChange(async (value) => {
                    this.plugin.writeOptions(() => ({
                        plannerPath: value || DEFAULT_PLANNER_PATH,
                    }));
                });
            });

        new obsidian.Setting(this.containerEl)
            .setName("Date format")
            .setDesc("Format used when creating a new planner date section")
            .addDropdown(drop => {
                drop.addOption("DD/MM/YYYY", "DD/MM/YYYY");
                drop.addOption("YYYY-MM-DD", "YYYY-MM-DD");
                drop.setValue(this.plugin.options.dateFormat === "YYYY-MM-DD" ? "YYYY-MM-DD" : "DD/MM/YYYY");
                drop.onChange(async value => { await this.plugin.writeOptions(() => ({ dateFormat: value })); });
            });

        new obsidian.Setting(this.containerEl)
            .setName("Max entries per day")
            .setDesc("Maximum number of entries to show on each calendar day (1-6)")
            .addSlider((slider) => {
                slider.setLimits(1, 6, 1);
                slider.setValue(this.plugin.options.maxEntriesPerDay || 3);
                slider.setDynamicTooltip();
                slider.onChange(async (value) => {
                    this.plugin.writeOptions(() => ({
                        maxEntriesPerDay: value,
                    }));
                });
            });

        this.containerEl.createEl("h3", { text: "Day View" });
        new obsidian.Setting(this.containerEl)
            .setName("First visible hour")
            .setDesc("The timeline expands automatically for earlier tasks.")
            .addDropdown(drop => {
                for (let h = 0; h <= 22; h++) drop.addOption(String(h), `${String(h).padStart(2, "0")}:00`);
                drop.setValue(String(this.plugin.options.dayStartHour ?? 6));
                drop.onChange(async value => { await this.plugin.writeOptions(() => ({ dayStartHour: Number(value) })); });
            });
        new obsidian.Setting(this.containerEl)
            .setName("Last visible hour")
            .setDesc("The timeline expands automatically for later tasks.")
            .addDropdown(drop => {
                for (let h = 1; h <= 24; h++) drop.addOption(String(h), `${String(h).padStart(2, "0")}:00`);
                drop.setValue(String(this.plugin.options.dayEndHour ?? 23));
                drop.onChange(async value => { await this.plugin.writeOptions(() => ({ dayEndHour: Number(value) })); });
            });
        new obsidian.Setting(this.containerEl)
            .setName("Timeline hour height")
            .setDesc("Spacing between hour markers in pixels (44–120).")
            .addSlider(slider => {
                slider.setLimits(44, 120, 4).setValue(this.plugin.options.timelineHourHeight ?? 76).setDynamicTooltip();
                slider.onChange(async val => { await this.plugin.writeOptions(() => ({ timelineHourHeight: val })); });
            });
        new obsidian.Setting(this.containerEl)
            .setName("Default task duration")
            .setDesc("Length of a new timed task in minutes.")
            .addDropdown(drop => {
                for (const mins of [15, 30, 45, 60, 90, 120]) drop.addOption(String(mins), `${mins} minutes`);
                drop.setValue(String(this.plugin.options.defaultTaskMinutes ?? 60));
                drop.onChange(async val => { await this.plugin.writeOptions(() => ({ defaultTaskMinutes: Number(val) })); });
            });

        this.containerEl.createEl("h3", {
            text: "General Settings",
        });

        this.addWeekStartSetting();
        this.addShowWeeklyNoteSetting();
        this.addLocaleOverrideSetting();
    }

    addWeekStartSetting() {
        const { moment } = window;
        const localizedWeekdays = moment.weekdays();
        const localeWeekStartNum = window._bundledLocaleWeekSpec?.dow || 0;
        const localeWeekStart = moment.weekdays()[localeWeekStartNum];
        new obsidian.Setting(this.containerEl)
            .setName("Start week on:")
            .setDesc("Choose what day of the week to start")
            .addDropdown((dropdown) => {
                dropdown.addOption("locale", `Locale default (${localeWeekStart})`);
                localizedWeekdays.forEach((day, i) => {
                    dropdown.addOption(weekdays$1[i], day);
                });
                dropdown.setValue(this.plugin.options.weekStart);
                dropdown.onChange(async (value) => {
                    this.plugin.writeOptions(() => ({
                        weekStart: value,
                    }));
                });
            });
    }

    addShowWeeklyNoteSetting() {
        new obsidian.Setting(this.containerEl)
            .setName("Show week number")
            .setDesc("Enable this to add a column with the week number")
            .addToggle((toggle) => {
                toggle.setValue(this.plugin.options.showWeeklyNote);
                toggle.onChange(async (value) => {
                    this.plugin.writeOptions(() => ({ showWeeklyNote: value }));
                    this.display();
                });
            });
    }

    addLocaleOverrideSetting() {
        var _a;
        const { moment } = window;
        const sysLocale = (_a = navigator.language) === null || _a === void 0 ? void 0 : _a.toLowerCase();
        new obsidian.Setting(this.containerEl)
            .setName("Override locale:")
            .setDesc("Set this if you want to use a locale different from the default")
            .addDropdown((dropdown) => {
                dropdown.addOption("system-default", `Same as system (${sysLocale})`);
                moment.locales().forEach((locale) => {
                    dropdown.addOption(locale, locale);
                });
                dropdown.setValue(this.plugin.options.localeOverride);
                dropdown.onChange(async (value) => {
                    this.plugin.writeOptions(() => ({
                        localeOverride: value,
                    }));
                });
            });
    }
}

// ============================================
// UTILITY FUNCTIONS
// ============================================

const classList = (obj) => {
    return Object.entries(obj)
        .filter(([_k, v]) => !!v)
        .map(([k, _k]) => k);
};

function clamp(num, lowerBound, upperBound) {
    return Math.min(Math.max(lowerBound, num), upperBound);
}

function getDateUID$1(date, granularity = "day") {
    const ts = date.clone().startOf(granularity).format();
    return `${granularity}-${ts}`;
}

// ============================================
// STORES
// ============================================

const settings = writable(defaultSettings);

function createSelectedFileStore() {
    const store = writable(null);
    return Object.assign({ 
        setDate: (date) => {
            if (!date) {
                store.set(null);
                return;
            }
            const id = getDateUID$1(date, "day");
            store.set(id);
        }
    }, store);
}

const activeFile = createSelectedFileStore();

// ============================================
// PLANNER MODAL - Shows tasks for a date
// ============================================

class PlannerDayModal extends obsidian.Modal {
    constructor(app, date, parser, onUpdate) {
        super(app);
        this.date = date;
        this.parser = parser;
        this.onUpdate = onUpdate;
        this.viewportHandler = null;
    }

    onOpen() {
        const { contentEl } = this;
        const { moment } = window;
        
        contentEl.empty();
        contentEl.addClass('planner-day-modal');
        
        // Add class to modal container for CSS targeting
        this.containerEl.addClass('planner-modal-container');
        
        // Add modal styles
        this.addStyles();
        
        // Handle mobile keyboard resize
        this.setupMobileKeyboardHandler();
        
        const dateStr = moment(this.date).format("dddd, MMMM D, YYYY");
        contentEl.createEl("h2", { text: dateStr });
        
        const data = this.parser.getDataForDate(this.date);
        
        if (data && data.tasks && data.tasks.length > 0) {
            const taskList = contentEl.createEl("ul", { cls: "planner-task-list" });
            
            data.tasks.forEach((task, index) => {
                if (task.isNote) {
                    const noteEl = taskList.createEl("li", { 
                        cls: "planner-note",
                        text: task.text 
                    });
                } else {
                    const taskEl = taskList.createEl("li", { cls: "planner-task" });
                    
                    if (task.completed) {
                        // Show clickable checkmark for completed tasks
                        const checkmark = taskEl.createEl("span", { 
                            cls: "planner-checkmark clickable",
                            text: "✓"
                        });
                        checkmark.addEventListener("click", async () => {
                            await this.parser.toggleTaskCompletion(this.date, index);
                            this.onUpdate();
                            this.onOpen(); // Refresh the modal
                        });
                    } else {
                        // Show clickable checkbox for incomplete tasks
                        const checkbox = taskEl.createEl("input", { type: "checkbox" });
                        checkbox.checked = false;
                        checkbox.addEventListener("change", async () => {
                            await this.parser.toggleTaskCompletion(this.date, index);
                            this.onUpdate();
                            this.onOpen(); // Refresh the modal
                        });
                    }
                    
                    const textSpan = taskEl.createEl("span", { 
                        text: task.text,
                        cls: task.completed ? "completed" : ""
                    });
                    
                    // Show date range badge if this is a range entry
                    if (task.hasRange || task.isRangeEntry) {
                        const fromDate = task.fromDate ? moment(task.fromDate).format("DD/MM") : "";
                        const toDate = task.toDate ? moment(task.toDate).format("DD/MM") : "";
                        if (fromDate && toDate) {
                            taskEl.createEl("span", {
                                cls: "planner-task-range-badge",
                                text: `${fromDate} → ${toDate}`
                            });
                        }
                    }
                }
            });
        } else {
            contentEl.createEl("p", { 
                text: "No entries for this day.",
                cls: "planner-empty"
            });
        }
        
        // Add new task input at bottom
        const inputContainer = contentEl.createDiv({ cls: "planner-input-container" });
        const input = inputContainer.createEl("input", {
            type: "text",
            placeholder: "Add new entry...",
            cls: "planner-new-task-input"
        });
        
        const addButton = inputContainer.createEl("button", { 
            text: "Add",
            cls: "planner-add-button"
        });
        
        // Date range toggle and inputs
        const rangeContainer = contentEl.createDiv({ cls: "planner-range-container" });
        
        const rangeToggle = rangeContainer.createEl("label", { cls: "planner-range-toggle" });
        const rangeCheckbox = rangeToggle.createEl("input", { type: "checkbox" });
        rangeToggle.createEl("span", { text: " Multi-day event" });
        
        const rangeDatesContainer = rangeContainer.createDiv({ cls: "planner-range-dates hidden" });
        
        const fromLabel = rangeDatesContainer.createEl("label", { cls: "planner-date-label" });
        fromLabel.createEl("span", { text: "From: " });
        const fromInput = fromLabel.createEl("input", {
            type: "date",
            cls: "planner-date-input",
            value: moment(this.date).format("YYYY-MM-DD")
        });
        
        const toLabel = rangeDatesContainer.createEl("label", { cls: "planner-date-label" });
        toLabel.createEl("span", { text: "To: " });
        const toInput = toLabel.createEl("input", {
            type: "date",
            cls: "planner-date-input",
            value: moment(this.date).add(1, 'day').format("YYYY-MM-DD")
        });
        
        rangeCheckbox.addEventListener("change", () => {
            if (rangeCheckbox.checked) {
                rangeDatesContainer.removeClass("hidden");
            } else {
                rangeDatesContainer.addClass("hidden");
            }
        });
        
        const addTask = async () => {
            const text = input.value.trim();
            if (text) {
                if (rangeCheckbox.checked) {
                    const fromDate = fromInput.value ? window.moment(fromInput.value, 'YYYY-MM-DD', true) : null;
                    const toDate = toInput.value ? window.moment(toInput.value, 'YYYY-MM-DD', true) : null;
                    await this.parser.addEntryForDate(this.date, text, fromDate, toDate);
                } else {
                    await this.parser.addEntryForDate(this.date, text);
                }
                input.value = "";
                rangeCheckbox.checked = false;
                rangeDatesContainer.addClass("hidden");
                this.onUpdate();
                this.onOpen(); // Refresh the modal
            }
        };
        
        addButton.addEventListener("click", addTask);
        input.addEventListener("keypress", (e) => {
            if (e.key === "Enter") {
                addTask();
            }
        });
        
        // Open in planner button
        const openButton = contentEl.createEl("button", { 
            text: "Open Planner File",
            cls: "planner-open-button"
        });
        openButton.addEventListener("click", async () => {
            const plannerFile = this.app.vault.getAbstractFileByPath(this.parser.plannerPath);
            if (plannerFile && plannerFile instanceof obsidian__default['default'].TFile) {
                const leaf = this.app.workspace.getUnpinnedLeaf();
                await leaf.openFile(plannerFile);
                
                // Navigate to the date section
                const data = this.parser.getDataForDate(this.date);
                if (data && data.lineStart !== undefined) {
                    const view = leaf.view;
                    if (view.editor) {
                        view.editor.setCursor({ line: data.lineStart, ch: 0 });
                        view.editor.scrollIntoView({ from: { line: data.lineStart, ch: 0 }, to: { line: data.lineStart, ch: 0 } }, true);
                    }
                }
                this.close();
            }
        });
    }

    addStyles() {
        // Only add styles once
        if (document.getElementById('planner-modal-styles')) return;
        
        const styleEl = document.createElement('style');
        styleEl.id = 'planner-modal-styles';
        styleEl.textContent = `
            .planner-day-modal {
                padding: 10px;
                overflow-y: auto;
                -webkit-overflow-scrolling: touch;
            }
            .planner-day-modal h2 {
                margin-top: 0;
                margin-bottom: 16px;
            }
            .planner-task-list {
                list-style: none;
                padding: 0;
                margin: 0 0 20px 0;
            }
            .planner-task-list li {
                padding: 8px 0;
                border-bottom: 1px solid var(--background-modifier-border);
                display: flex;
                align-items: center;
                gap: 10px;
            }
            .planner-task-list li:last-child {
                border-bottom: none;
            }
            .planner-task-list input[type="checkbox"] {
                width: 24px;
                height: 24px;
                min-width: 24px;
                min-height: 24px;
                margin: 0;
                cursor: pointer;
                accent-color: var(--interactive-accent);
                flex-shrink: 0;
                -webkit-tap-highlight-color: transparent;
            }
            .planner-task-list .completed {
                text-decoration: line-through;
                opacity: 0.6;
            }
            .planner-checkmark {
                display: inline-flex;
                align-items: center;
                justify-content: center;
                width: 24px;
                height: 24px;
                min-width: 24px;
                min-height: 24px;
                background: var(--interactive-accent);
                color: var(--text-on-accent);
                border-radius: 4px;
                font-size: 14px;
                font-weight: bold;
                flex-shrink: 0;
                -webkit-tap-highlight-color: transparent;
            }
            .planner-checkmark.clickable {
                cursor: pointer;
                transition: opacity 0.15s ease, transform 0.1s ease;
            }
            .planner-checkmark.clickable:hover {
                opacity: 0.8;
            }
            .planner-checkmark.clickable:active {
                transform: scale(0.95);
            }
            .planner-note {
                font-style: italic;
                color: var(--text-muted);
            }
            .planner-empty {
                color: var(--text-muted);
                font-style: italic;
                margin-bottom: 20px;
            }
            .planner-input-container {
                display: flex;
                gap: 8px;
                margin-bottom: 16px;
            }
            .planner-new-task-input {
                flex: 1;
                padding: 8px 12px;
                border: 1px solid var(--background-modifier-border);
                border-radius: 6px;
                background: var(--background-primary);
                color: var(--text-normal);
                font-size: 14px;
            }
            .planner-new-task-input:focus {
                outline: none;
                border-color: var(--interactive-accent);
                box-shadow: 0 0 0 2px var(--interactive-accent-hover);
            }
            .planner-add-button,
            .planner-open-button {
                padding: 8px 16px;
                border: none;
                border-radius: 6px;
                cursor: pointer;
                font-size: 14px;
                font-weight: 500;
                transition: background-color 0.15s ease;
            }
            .planner-add-button {
                background: var(--interactive-accent);
                color: var(--text-on-accent);
            }
            .planner-add-button:hover {
                background: var(--interactive-accent-hover);
            }
            .planner-open-button {
                background: var(--background-modifier-hover);
                color: var(--text-normal);
            }
            .planner-open-button:hover {
                background: var(--background-modifier-border);
            }
            .planner-range-container {
                margin-bottom: 16px;
            }
            .planner-range-toggle {
                display: flex;
                align-items: center;
                gap: 6px;
                cursor: pointer;
                font-size: 14px;
                color: var(--text-muted);
                margin-bottom: 8px;
            }
            .planner-range-toggle input[type="checkbox"] {
                width: 16px;
                height: 16px;
                cursor: pointer;
            }
            .planner-range-dates {
                display: flex;
                gap: 12px;
                flex-wrap: wrap;
            }
            .planner-range-dates.hidden {
                display: none;
            }
            .planner-date-label {
                display: flex;
                align-items: center;
                gap: 6px;
                font-size: 14px;
                color: var(--text-normal);
            }
            .planner-date-input {
                padding: 6px 10px;
                border: 1px solid var(--background-modifier-border);
                border-radius: 6px;
                background: var(--background-primary);
                color: var(--text-normal);
                font-size: 14px;
            }
            .planner-date-input:focus {
                outline: none;
                border-color: var(--interactive-accent);
            }
            .planner-task-range-badge {
                display: inline-block;
                padding: 2px 6px;
                background: var(--interactive-accent);
                color: var(--text-on-accent);
                border-radius: 4px;
                font-size: 11px;
                margin-left: 8px;
            }
        `;
        document.head.appendChild(styleEl);
    }

    setupMobileKeyboardHandler() {
        // Position modal at top via JS to override Obsidian defaults
        // modalEl is the actual modal element in Obsidian's Modal class
        this.modalEl.style.position = 'absolute';
        this.modalEl.style.top = '5%';
        this.modalEl.style.left = '50%';
        this.modalEl.style.right = 'auto';
        this.modalEl.style.bottom = 'auto';
        this.modalEl.style.transform = 'translateX(-50%)';
        this.modalEl.style.margin = '0';
        this.modalEl.style.maxHeight = '50vh';
        
        this.contentEl.style.maxHeight = '45vh';
        this.contentEl.style.overflowY = 'auto';
    }

    onClose() {
        const { contentEl } = this;
        contentEl.empty();
        
        // Remove custom class
        this.containerEl.removeClass("planner-modal-container");
    }
}

// ============================================
// SVELTE COMPONENTS (simplified inline)
// ============================================

function noop() { }
function assign(tar, src) {
    for (const k in src)
        tar[k] = src[k];
    return tar;
}
function is_promise(value) {
    return value && typeof value === 'object' && typeof value.then === 'function';
}
function run(fn) {
    return fn();
}
function blank_object() {
    return Object.create(null);
}
function run_all(fns) {
    fns.forEach(run);
}
function is_function(thing) {
    return typeof thing === 'function';
}
function safe_not_equal(a, b) {
    return a != a ? b == b : a !== b || ((a && typeof a === 'object') || typeof a === 'function');
}
function not_equal(a, b) {
    return a != a ? b == b : a !== b;
}
function is_empty(obj) {
    return Object.keys(obj).length === 0;
}
function create_slot(definition, ctx, $$scope, fn) {
    if (definition) {
        const slot_ctx = get_slot_context(definition, ctx, $$scope, fn);
        return definition[0](slot_ctx);
    }
}
function get_slot_context(definition, ctx, $$scope, fn) {
    return definition[1] && fn
        ? assign($$scope.ctx.slice(), definition[1](fn(ctx)))
        : $$scope.ctx;
}
function get_slot_changes(definition, $$scope, dirty, fn) {
    if (definition[2] && fn) {
        const lets = definition[2](fn(dirty));
        if ($$scope.dirty === undefined) {
            return lets;
        }
        if (typeof lets === 'object') {
            const merged = [];
            const len = Math.max($$scope.dirty.length, lets.length);
            for (let i = 0; i < len; i += 1) {
                merged[i] = $$scope.dirty[i] | lets[i];
            }
            return merged;
        }
        return $$scope.dirty | lets;
    }
    return $$scope.dirty;
}
function update_slot(slot, slot_definition, ctx, $$scope, dirty, get_slot_changes_fn, get_slot_context_fn) {
    const slot_changes = get_slot_changes(slot_definition, $$scope, dirty, get_slot_changes_fn);
    if (slot_changes) {
        const slot_context = get_slot_context(slot_definition, ctx, $$scope, get_slot_context_fn);
        slot.p(slot_context, slot_changes);
    }
}
function null_to_empty(value) {
    return value == null ? '' : value;
}

function append(target, node) {
    target.appendChild(node);
}
function insert(target, node, anchor) {
    target.insertBefore(node, anchor || null);
}
function detach(node) {
    node.parentNode.removeChild(node);
}
function destroy_each(iterations, detaching) {
    for (let i = 0; i < iterations.length; i += 1) {
        if (iterations[i])
            iterations[i].d(detaching);
    }
}
function element(name) {
    return document.createElement(name);
}
function svg_element(name) {
    return document.createElementNS('http://www.w3.org/2000/svg', name);
}
function text(data) {
    return document.createTextNode(data);
}
function space() {
    return text(' ');
}
function empty() {
    return text('');
}
function listen(node, event, handler, options) {
    node.addEventListener(event, handler, options);
    return () => node.removeEventListener(event, handler, options);
}
function attr(node, attribute, value) {
    if (value == null)
        node.removeAttribute(attribute);
    else if (node.getAttribute(attribute) !== value)
        node.setAttribute(attribute, value);
}
function set_attributes(node, attributes) {
    const descriptors = Object.getOwnPropertyDescriptors(node.__proto__);
    for (const key in attributes) {
        if (attributes[key] == null) {
            node.removeAttribute(key);
        }
        else if (key === 'style') {
            node.style.cssText = attributes[key];
        }
        else if (key === '__value') {
            node.value = node[key] = attributes[key];
        }
        else if (descriptors[key] && descriptors[key].set) {
            node[key] = attributes[key];
        }
        else {
            attr(node, key, attributes[key]);
        }
    }
}
function children(element) {
    return Array.from(element.childNodes);
}
function set_data(text, data) {
    data = '' + data;
    if (text.wholeText !== data)
        text.data = data;
}
function toggle_class(element, name, toggle) {
    element.classList[toggle ? 'add' : 'remove'](name);
}

let current_component;
function set_current_component(component) {
    current_component = component;
}
function get_current_component() {
    if (!current_component)
        throw new Error('Function called outside component initialization');
    return current_component;
}

const dirty_components = [];
const binding_callbacks = [];
const render_callbacks = [];
const flush_callbacks = [];
const resolved_promise = Promise.resolve();
let update_scheduled = false;
function schedule_update() {
    if (!update_scheduled) {
        update_scheduled = true;
        resolved_promise.then(flush);
    }
}
function add_render_callback(fn) {
    render_callbacks.push(fn);
}
let flushing = false;
const seen_callbacks = new Set();
function flush() {
    if (flushing)
        return;
    flushing = true;
    do {
        for (let i = 0; i < dirty_components.length; i += 1) {
            const component = dirty_components[i];
            set_current_component(component);
            update(component.$$);
        }
        set_current_component(null);
        dirty_components.length = 0;
        while (binding_callbacks.length)
            binding_callbacks.pop()();
        for (let i = 0; i < render_callbacks.length; i += 1) {
            const callback = render_callbacks[i];
            if (!seen_callbacks.has(callback)) {
                seen_callbacks.add(callback);
                callback();
            }
        }
        render_callbacks.length = 0;
    } while (dirty_components.length);
    while (flush_callbacks.length) {
        flush_callbacks.pop()();
    }
    update_scheduled = false;
    flushing = false;
    seen_callbacks.clear();
}
function update($$) {
    if ($$.fragment !== null) {
        $$.update();
        run_all($$.before_update);
        const dirty = $$.dirty;
        $$.dirty = [-1];
        $$.fragment && $$.fragment.p($$.ctx, dirty);
        $$.after_update.forEach(add_render_callback);
    }
}
const outroing = new Set();
let outros;
function group_outros() {
    outros = {
        r: 0,
        c: [],
        p: outros
    };
}
function check_outros() {
    if (!outros.r) {
        run_all(outros.c);
    }
    outros = outros.p;
}
function transition_in(block, local) {
    if (block && block.i) {
        outroing.delete(block);
        block.i(local);
    }
}
function transition_out(block, local, detach, callback) {
    if (block && block.o) {
        if (outroing.has(block))
            return;
        outroing.add(block);
        outros.c.push(() => {
            outroing.delete(block);
            if (callback) {
                if (detach)
                    block.d(1);
                callback();
            }
        });
        block.o(local);
    }
}

function handle_promise(promise, info) {
    const token = info.token = {};
    function update(type, index, key, value) {
        if (info.token !== token)
            return;
        info.resolved = value;
        let child_ctx = info.ctx;
        if (key !== undefined) {
            child_ctx = child_ctx.slice();
            child_ctx[key] = value;
        }
        const block = type && (info.current = type)(child_ctx);
        let needs_flush = false;
        if (info.block) {
            if (info.blocks) {
                info.blocks.forEach((block, i) => {
                    if (i !== index && block) {
                        group_outros();
                        transition_out(block, 1, 1, () => {
                            if (info.blocks[i] === block) {
                                info.blocks[i] = null;
                            }
                        });
                        check_outros();
                    }
                });
            }
            else {
                info.block.d(1);
            }
            block.c();
            transition_in(block, 1);
            block.m(info.mount(), info.anchor);
            needs_flush = true;
        }
        info.block = block;
        if (info.blocks)
            info.blocks[index] = block;
        if (needs_flush) {
            flush();
        }
    }
    if (is_promise(promise)) {
        const current_component = get_current_component();
        promise.then(value => {
            set_current_component(current_component);
            update(info.then, 1, info.value, value);
            set_current_component(null);
        }, error => {
            set_current_component(current_component);
            update(info.catch, 2, info.error, error);
            set_current_component(null);
            if (!info.hasCatch) {
                throw error;
            }
        });
        if (info.current !== info.pending) {
            update(info.pending, 0);
            return true;
        }
    }
    else {
        if (info.current !== info.then) {
            update(info.then, 1, info.value, promise);
            return true;
        }
        info.resolved = promise;
    }
}
function outro_and_destroy_block(block, lookup) {
    transition_out(block, 1, 1, () => {
        lookup.delete(block.key);
    });
}
function update_keyed_each(old_blocks, dirty, get_key, dynamic, ctx, list, lookup, node, destroy, create_each_block, next, get_context) {
    let o = old_blocks.length;
    let n = list.length;
    let i = o;
    const old_indexes = {};
    while (i--)
        old_indexes[old_blocks[i].key] = i;
    const new_blocks = [];
    const new_lookup = new Map();
    const deltas = new Map();
    i = n;
    while (i--) {
        const child_ctx = get_context(ctx, list, i);
        const key = get_key(child_ctx);
        let block = lookup.get(key);
        if (!block) {
            block = create_each_block(key, child_ctx);
            block.c();
        }
        else if (dynamic) {
            block.p(child_ctx, dirty);
        }
        new_lookup.set(key, new_blocks[i] = block);
        if (key in old_indexes)
            deltas.set(key, Math.abs(i - old_indexes[key]));
    }
    const will_move = new Set();
    const did_move = new Set();
    function insert(block) {
        transition_in(block, 1);
        block.m(node, next);
        lookup.set(block.key, block);
        next = block.first;
        n--;
    }
    while (o && n) {
        const new_block = new_blocks[n - 1];
        const old_block = old_blocks[o - 1];
        const new_key = new_block.key;
        const old_key = old_block.key;
        if (new_block === old_block) {
            next = new_block.first;
            o--;
            n--;
        }
        else if (!new_lookup.has(old_key)) {
            destroy(old_block, lookup);
            o--;
        }
        else if (!lookup.has(new_key) || will_move.has(new_key)) {
            insert(new_block);
        }
        else if (did_move.has(old_key)) {
            o--;
        }
        else if (deltas.get(new_key) > deltas.get(old_key)) {
            did_move.add(new_key);
            insert(new_block);
        }
        else {
            will_move.add(old_key);
            o--;
        }
    }
    while (o--) {
        const old_block = old_blocks[o];
        if (!new_lookup.has(old_block.key))
            destroy(old_block, lookup);
    }
    while (n)
        insert(new_blocks[n - 1]);
    return new_blocks;
}

function get_spread_update(levels, updates) {
    const update = {};
    const to_null_out = {};
    const accounted_for = { $$scope: 1 };
    let i = levels.length;
    while (i--) {
        const o = levels[i];
        const n = updates[i];
        if (n) {
            for (const key in o) {
                if (!(key in n))
                    to_null_out[key] = 1;
            }
            for (const key in n) {
                if (!accounted_for[key]) {
                    update[key] = n[key];
                    accounted_for[key] = 1;
                }
            }
            levels[i] = n;
        }
        else {
            for (const key in o) {
                accounted_for[key] = 1;
            }
        }
    }
    for (const key in to_null_out) {
        if (!(key in update))
            update[key] = undefined;
    }
    return update;
}
function get_spread_object(spread_props) {
    return typeof spread_props === 'object' && spread_props !== null ? spread_props : {};
}
function create_component(block) {
    block && block.c();
}
function mount_component(component, target, anchor, customElement) {
    const { fragment, on_mount, on_destroy, after_update } = component.$$;
    fragment && fragment.m(target, anchor);
    if (!customElement) {
        add_render_callback(() => {
            const new_on_destroy = on_mount.map(run).filter(is_function);
            if (on_destroy) {
                on_destroy.push(...new_on_destroy);
            }
            else {
                run_all(new_on_destroy);
            }
            component.$$.on_mount = [];
        });
    }
    after_update.forEach(add_render_callback);
}
function destroy_component(component, detaching) {
    const $$ = component.$$;
    if ($$.fragment !== null) {
        run_all($$.on_destroy);
        $$.fragment && $$.fragment.d(detaching);
        $$.on_destroy = $$.fragment = null;
        $$.ctx = [];
    }
}
function make_dirty(component, i) {
    if (component.$$.dirty[0] === -1) {
        dirty_components.push(component);
        schedule_update();
        component.$$.dirty.fill(0);
    }
    component.$$.dirty[(i / 31) | 0] |= (1 << (i % 31));
}
function init(component, options, instance, create_fragment, not_equal, props, dirty = [-1]) {
    const parent_component = current_component;
    set_current_component(component);
    const $$ = component.$$ = {
        fragment: null,
        ctx: null,
        props,
        update: noop,
        not_equal,
        bound: blank_object(),
        on_mount: [],
        on_destroy: [],
        on_disconnect: [],
        before_update: [],
        after_update: [],
        context: new Map(parent_component ? parent_component.$$.context : []),
        callbacks: blank_object(),
        dirty,
        skip_bound: false
    };
    let ready = false;
    $$.ctx = instance
        ? instance(component, options.props || {}, (i, ret, ...rest) => {
            const value = rest.length ? rest[0] : ret;
            if ($$.ctx && not_equal($$.ctx[i], $$.ctx[i] = value)) {
                if (!$$.skip_bound && $$.bound[i])
                    $$.bound[i](value);
                if (ready)
                    make_dirty(component, i);
            }
            return ret;
        })
        : [];
    $$.update();
    ready = true;
    run_all($$.before_update);
    $$.fragment = create_fragment ? create_fragment($$.ctx) : false;
    if (options.target) {
        if (options.hydrate) {
            const nodes = children(options.target);
            $$.fragment && $$.fragment.l(nodes);
            nodes.forEach(detach);
        }
        else {
            $$.fragment && $$.fragment.c();
        }
        if (options.intro)
            transition_in(component.$$.fragment);
        mount_component(component, options.target, options.anchor, options.customElement);
        flush();
    }
    set_current_component(parent_component);
}

class SvelteComponent {
    $destroy() {
        destroy_component(this, 1);
        this.$destroy = noop;
    }
    $on(type, callback) {
        const callbacks = (this.$$.callbacks[type] || (this.$$.callbacks[type] = []));
        callbacks.push(callback);
        return () => {
            const index = callbacks.indexOf(callback);
            if (index !== -1)
                callbacks.splice(index, 1);
        };
    }
    $set($$props) {
        if (this.$$set && !is_empty($$props)) {
            this.$$.skip_bound = true;
            this.$$set($$props);
            this.$$.skip_bound = false;
        }
    }
}

// ============================================
// CALENDAR HELPER FUNCTIONS
// ============================================

function getDateUID(date, granularity = "day") {
    const ts = date.clone().startOf(granularity).format();
    return `${granularity}-${ts}`;
}
var getDateUID_1 = getDateUID;

function isMacOS() {
    return navigator.appVersion.indexOf("Mac") !== -1;
}
function isMetaPressed(e) {
    return isMacOS() ? e.metaKey : e.ctrlKey;
}
function getDaysOfWeek(..._args) {
    return window.moment.weekdaysShort(true);
}
function isWeekend(date) {
    return date.isoWeekday() === 6 || date.isoWeekday() === 7;
}
function getStartOfWeek(days) {
    return days[0].weekday(0);
}

function getMonth(displayedMonth, ..._args) {
    const locale = window.moment().locale();
    const month = [];
    let week;
    const startOfMonth = displayedMonth.clone().locale(locale).date(1);
    const startOffset = startOfMonth.weekday();
    let date = startOfMonth.clone().subtract(startOffset, "days");
    for (let _day = 0; _day < 42; _day++) {
        if (_day % 7 === 0) {
            week = {
                days: [],
                weekNum: date.week(),
            };
            month.push(week);
        }
        week.days.push(date);
        date = date.clone().add(1, "days");
    }
    return month;
}

// ============================================
// METADATA SOURCES - Modified to use PlannerParser
// ============================================

async function metadataReducer(promisedMetadata) {
    const meta = {
        dots: [],
        classes: [],
        dataAttributes: {},
        entries: [],
    };
    const metas = await Promise.all(promisedMetadata);
    return metas.reduce((acc, meta) => ({
        classes: [...acc.classes, ...(meta.classes || [])],
        dataAttributes: Object.assign(acc.dataAttributes, meta.dataAttributes),
        dots: [...acc.dots, ...(meta.dots || [])],
        entries: [...acc.entries, ...(meta.entries || [])],
    }), meta);
}

function getDailyMetadata(sources, date, ..._args) {
    return metadataReducer(sources.map((source) => source.getDailyMetadata(date)));
}

function getWeeklyMetadata(sources, date, ..._args) {
    return metadataReducer(sources.map((source) => source.getWeeklyMetadata(date)));
}

// Planner-based streak source
function createPlannerStreakSource(parser) {
    return {
        getDailyMetadata: async (date) => {
            const hasData = parser.hasDataForDate(date);
            return {
                classes: classList({
                    "has-note": hasData,
                }),
                dots: [],
            };
        },
        getWeeklyMetadata: async (date) => {
            return {
                classes: [],
                dots: [],
            };
        },
    };
}

// Planner-based task source - includes entry text for display
function createPlannerTaskSource(parser, settingsStore) {
    return {
        getDailyMetadata: async (date) => {
            const currentSettings = get_store_value(settingsStore);
            const maxEntries = currentSettings.maxEntriesPerDay || 3;
            const data = parser.getDataForDate(date);
            const rangeEntries = parser.getRangeEntriesForDate(date);
            const entries = [];
            
            if (data && data.tasks) {
                const allEntries = data.tasks.slice(0, maxEntries);
                const remainingCount = data.tasks.length - maxEntries;
                
                allEntries.forEach(task => {
                    const displayText = task.text.length > 12 ? task.text.substring(0, 12) + '…' : task.text;
                    entries.push({
                        text: displayText,
                        completed: task.completed,
                        isNote: task.isNote,
                        isRangeEntry: task.isRangeEntry || task.hasRange,
                        rangePosition: task.rangePosition || (task.hasRange ? 'start' : null)
                    });
                });
                
                if (remainingCount > 0) {
                    entries.push({
                        text: `+${remainingCount} more`,
                        isOverflow: true
                    });
                }
            }
            
            return { 
                dots: [], 
                entries,
                hasRangeEntries: rangeEntries.length > 0
            };
        },
        getWeeklyMetadata: async (date) => {
            return { dots: [], entries: [] };
        },
    };
}

// ============================================
// DOT COMPONENT
// ============================================

function add_css$5() {
    var style = element("style");
    style.id = "svelte-1widvzq-style";
    style.textContent = ".dot.svelte-1widvzq,.hollow.svelte-1widvzq{display:inline-block;height:6px;width:6px;margin:0 1px}.filled.svelte-1widvzq{fill:var(--color-dot)}.active.filled.svelte-1widvzq{fill:var(--text-on-accent)}.hollow.svelte-1widvzq{fill:none;stroke:var(--color-dot)}.active.hollow.svelte-1widvzq{fill:none;stroke:var(--text-on-accent)}";
    append(document.head, style);
}

function create_else_block$1(ctx) {
    let svg;
    let circle;
    let svg_class_value;

    return {
        c() {
            svg = svg_element("svg");
            circle = svg_element("circle");
            attr(circle, "cx", "3");
            attr(circle, "cy", "3");
            attr(circle, "r", "2");
            attr(svg, "class", svg_class_value = "" + (null_to_empty(`hollow ${ctx[0]}`) + " svelte-1widvzq"));
            attr(svg, "viewBox", "0 0 6 6");
            attr(svg, "xmlns", "http://www.w3.org/2000/svg");
            toggle_class(svg, "active", ctx[2]);
        },
        m(target, anchor) {
            insert(target, svg, anchor);
            append(svg, circle);
        },
        p(ctx, dirty) {
            if (dirty & 1 && svg_class_value !== (svg_class_value = "" + (null_to_empty(`hollow ${ctx[0]}`) + " svelte-1widvzq"))) {
                attr(svg, "class", svg_class_value);
            }
            if (dirty & 5) {
                toggle_class(svg, "active", ctx[2]);
            }
        },
        d(detaching) {
            if (detaching) detach(svg);
        }
    };
}

function create_if_block$2(ctx) {
    let svg;
    let circle;
    let svg_class_value;

    return {
        c() {
            svg = svg_element("svg");
            circle = svg_element("circle");
            attr(circle, "cx", "3");
            attr(circle, "cy", "3");
            attr(circle, "r", "2");
            attr(svg, "class", svg_class_value = "" + (null_to_empty(`dot filled ${ctx[0]}`) + " svelte-1widvzq"));
            attr(svg, "viewBox", "0 0 6 6");
            attr(svg, "xmlns", "http://www.w3.org/2000/svg");
            toggle_class(svg, "active", ctx[2]);
        },
        m(target, anchor) {
            insert(target, svg, anchor);
            append(svg, circle);
        },
        p(ctx, dirty) {
            if (dirty & 1 && svg_class_value !== (svg_class_value = "" + (null_to_empty(`dot filled ${ctx[0]}`) + " svelte-1widvzq"))) {
                attr(svg, "class", svg_class_value);
            }
            if (dirty & 5) {
                toggle_class(svg, "active", ctx[2]);
            }
        },
        d(detaching) {
            if (detaching) detach(svg);
        }
    };
}

function create_fragment$6(ctx) {
    let if_block_anchor;

    function select_block_type(ctx, dirty) {
        if (ctx[1]) return create_if_block$2;
        return create_else_block$1;
    }

    let current_block_type = select_block_type(ctx);
    let if_block = current_block_type(ctx);

    return {
        c() {
            if_block.c();
            if_block_anchor = empty();
        },
        m(target, anchor) {
            if_block.m(target, anchor);
            insert(target, if_block_anchor, anchor);
        },
        p(ctx, [dirty]) {
            if (current_block_type === (current_block_type = select_block_type(ctx)) && if_block) {
                if_block.p(ctx, dirty);
            } else {
                if_block.d(1);
                if_block = current_block_type(ctx);
                if (if_block) {
                    if_block.c();
                    if_block.m(if_block_anchor.parentNode, if_block_anchor);
                }
            }
        },
        i: noop,
        o: noop,
        d(detaching) {
            if_block.d(detaching);
            if (detaching) detach(if_block_anchor);
        }
    };
}

function instance$6($$self, $$props, $$invalidate) {
    let { className = "" } = $$props;
    let { isFilled } = $$props;
    let { isActive } = $$props;

    $$self.$$set = $$props => {
        if ("className" in $$props) $$invalidate(0, className = $$props.className);
        if ("isFilled" in $$props) $$invalidate(1, isFilled = $$props.isFilled);
        if ("isActive" in $$props) $$invalidate(2, isActive = $$props.isActive);
    };

    return [className, isFilled, isActive];
}

class Dot extends SvelteComponent {
    constructor(options) {
        super();
        if (!document.getElementById("svelte-1widvzq-style")) add_css$5();
        init(this, options, instance$6, create_fragment$6, safe_not_equal, { className: 0, isFilled: 1, isActive: 2 });
    }
}

// ============================================
// METADATA RESOLVER COMPONENT
// ============================================

const get_default_slot_changes_1 = dirty => ({});
const get_default_slot_context_1 = ctx => ({ metadata: null });
const get_default_slot_changes = dirty => ({ metadata: dirty & 1 });
const get_default_slot_context = ctx => ({ metadata: ctx[3] });

function create_else_block(ctx) {
    let current;
    const default_slot_template = ctx[2].default;
    const default_slot = create_slot(default_slot_template, ctx, ctx[1], get_default_slot_context_1);

    return {
        c() {
            if (default_slot) default_slot.c();
        },
        m(target, anchor) {
            if (default_slot) {
                default_slot.m(target, anchor);
            }
            current = true;
        },
        p(ctx, dirty) {
            if (default_slot) {
                if (default_slot.p && dirty & 2) {
                    update_slot(default_slot, default_slot_template, ctx, ctx[1], dirty, get_default_slot_changes_1, get_default_slot_context_1);
                }
            }
        },
        i(local) {
            if (current) return;
            transition_in(default_slot, local);
            current = true;
        },
        o(local) {
            transition_out(default_slot, local);
            current = false;
        },
        d(detaching) {
            if (default_slot) default_slot.d(detaching);
        }
    };
}

function create_catch_block(ctx) {
    return {
        c: noop,
        m: noop,
        p: noop,
        i: noop,
        o: noop,
        d: noop
    };
}

function create_then_block(ctx) {
    let current;
    const default_slot_template = ctx[2].default;
    const default_slot = create_slot(default_slot_template, ctx, ctx[1], get_default_slot_context);

    return {
        c() {
            if (default_slot) default_slot.c();
        },
        m(target, anchor) {
            if (default_slot) {
                default_slot.m(target, anchor);
            }
            current = true;
        },
        p(ctx, dirty) {
            if (default_slot) {
                if (default_slot.p && dirty & 3) {
                    update_slot(default_slot, default_slot_template, ctx, ctx[1], dirty, get_default_slot_changes, get_default_slot_context);
                }
            }
        },
        i(local) {
            if (current) return;
            transition_in(default_slot, local);
            current = true;
        },
        o(local) {
            transition_out(default_slot, local);
            current = false;
        },
        d(detaching) {
            if (default_slot) default_slot.d(detaching);
        }
    };
}

function create_pending_block(ctx) {
    return {
        c: noop,
        m: noop,
        p: noop,
        i: noop,
        o: noop,
        d: noop
    };
}

function create_if_block$1(ctx) {
    let await_block_anchor;
    let promise;
    let current;

    let info = {
        ctx,
        current: null,
        token: null,
        hasCatch: false,
        pending: create_pending_block,
        then: create_then_block,
        catch: create_catch_block,
        value: 3,
        blocks: [,,,]
    };

    handle_promise(promise = ctx[0], info);

    return {
        c() {
            await_block_anchor = empty();
            info.block.c();
        },
        m(target, anchor) {
            insert(target, await_block_anchor, anchor);
            info.block.m(target, info.anchor = anchor);
            info.mount = () => await_block_anchor.parentNode;
            info.anchor = await_block_anchor;
            current = true;
        },
        p(new_ctx, dirty) {
            ctx = new_ctx;
            info.ctx = ctx;
            if (dirty & 1 && promise !== (promise = ctx[0]) && handle_promise(promise, info)) ;
            else {
                const child_ctx = ctx.slice();
                child_ctx[3] = info.resolved;
                info.block.p(child_ctx, dirty);
            }
        },
        i(local) {
            if (current) return;
            transition_in(info.block);
            current = true;
        },
        o(local) {
            for (let i = 0; i < 3; i += 1) {
                const block = info.blocks[i];
                transition_out(block);
            }
            current = false;
        },
        d(detaching) {
            if (detaching) detach(await_block_anchor);
            info.block.d(detaching);
            info.token = null;
            info = null;
        }
    };
}

function create_fragment$5(ctx) {
    let current_block_type_index;
    let if_block;
    let if_block_anchor;
    let current;
    const if_block_creators = [create_if_block$1, create_else_block];
    const if_blocks = [];

    function select_block_type(ctx, dirty) {
        if (ctx[0]) return 0;
        return 1;
    }

    current_block_type_index = select_block_type(ctx);
    if_block = if_blocks[current_block_type_index] = if_block_creators[current_block_type_index](ctx);

    return {
        c() {
            if_block.c();
            if_block_anchor = empty();
        },
        m(target, anchor) {
            if_blocks[current_block_type_index].m(target, anchor);
            insert(target, if_block_anchor, anchor);
            current = true;
        },
        p(ctx, [dirty]) {
            let previous_block_index = current_block_type_index;
            current_block_type_index = select_block_type(ctx);
            if (current_block_type_index === previous_block_index) {
                if_blocks[current_block_type_index].p(ctx, dirty);
            } else {
                group_outros();
                transition_out(if_blocks[previous_block_index], 1, 1, () => {
                    if_blocks[previous_block_index] = null;
                });
                check_outros();
                if_block = if_blocks[current_block_type_index];
                if (!if_block) {
                    if_block = if_blocks[current_block_type_index] = if_block_creators[current_block_type_index](ctx);
                    if_block.c();
                } else {
                    if_block.p(ctx, dirty);
                }
                transition_in(if_block, 1);
                if_block.m(if_block_anchor.parentNode, if_block_anchor);
            }
        },
        i(local) {
            if (current) return;
            transition_in(if_block);
            current = true;
        },
        o(local) {
            transition_out(if_block);
            current = false;
        },
        d(detaching) {
            if_blocks[current_block_type_index].d(detaching);
            if (detaching) detach(if_block_anchor);
        }
    };
}

function instance$5($$self, $$props, $$invalidate) {
    let { $$slots: slots = {}, $$scope } = $$props;
    let { metadata } = $$props;

    $$self.$$set = $$props => {
        if ("metadata" in $$props) $$invalidate(0, metadata = $$props.metadata);
        if ("$$scope" in $$props) $$invalidate(1, $$scope = $$props.$$scope);
    };

    return [metadata, $$scope, slots];
}

class MetadataResolver extends SvelteComponent {
    constructor(options) {
        super();
        init(this, options, instance$5, create_fragment$5, not_equal, { metadata: 0 });
    }
}

// ============================================
// DAY COMPONENT
// ============================================

function add_css$4() {
    var style = element("style");
    style.id = "svelte-q3wqg9-style";
    style.textContent = ".day.svelte-q3wqg9{background-color:var(--color-background-day);border-radius:4px;color:var(--color-text-day);cursor:pointer;font-size:0.8em;height:100%;min-height:70px;padding:4px;position:relative;text-align:center;transition:background-color 0.1s ease-in, color 0.1s ease-in;vertical-align:top}.day.svelte-q3wqg9:hover{background-color:var(--interactive-hover)}.day.active.svelte-q3wqg9:hover{background-color:var(--interactive-accent-hover)}.adjacent-month.svelte-q3wqg9{opacity:0.25}.today.svelte-q3wqg9{color:var(--color-text-today)}.day.svelte-q3wqg9:active,.active.svelte-q3wqg9,.active.today.svelte-q3wqg9{color:var(--text-on-accent);background-color:var(--interactive-accent)}.day-number.svelte-q3wqg9{font-weight:600;margin-bottom:2px}.entries-container.svelte-q3wqg9{display:flex;flex-direction:column;gap:1px;font-size:0.7em;text-align:left;line-height:1.2}.entry.svelte-q3wqg9{white-space:nowrap;overflow:hidden;text-overflow:ellipsis;padding:1px 2px;border-radius:2px;background:var(--background-modifier-hover)}.entry.completed.svelte-q3wqg9{text-decoration:line-through;opacity:0.6}.entry.overflow.svelte-q3wqg9{font-style:italic;color:var(--text-muted);background:none}.entry.range.svelte-q3wqg9{background:var(--interactive-accent);color:var(--text-on-accent);opacity:0.85}.entry.range-start.svelte-q3wqg9{border-radius:2px 0 0 2px;margin-right:-2px}.entry.range-middle.svelte-q3wqg9{border-radius:0;margin-left:-2px;margin-right:-2px}.entry.range-end.svelte-q3wqg9{border-radius:0 2px 2px 0;margin-left:-2px}.active .entry.svelte-q3wqg9{background:rgba(255,255,255,0.2)}.active .entry.range.svelte-q3wqg9{background:rgba(255,255,255,0.4)}.dot-container.svelte-q3wqg9{display:flex;flex-wrap:wrap;justify-content:center;line-height:6px;min-height:6px}";
    append(document.head, style);
}

function get_each_context$2(ctx, list, i) {
    const child_ctx = ctx.slice();
    child_ctx[11] = list[i];
    return child_ctx;
}

// Create entry element instead of dot
function create_each_block$2(ctx) {
    let div;
    let t_value = ctx[11].text + "";
    let t;

    return {
        c() {
            div = element("div");
            t = text(t_value);
            attr(div, "class", "entry svelte-q3wqg9");
            toggle_class(div, "completed", ctx[11].completed);
            toggle_class(div, "overflow", ctx[11].isOverflow);
            toggle_class(div, "range", ctx[11].isRangeEntry);
            toggle_class(div, "range-start", ctx[11].rangePosition === 'start');
            toggle_class(div, "range-middle", ctx[11].rangePosition === 'middle');
            toggle_class(div, "range-end", ctx[11].rangePosition === 'end');
        },
        m(target, anchor) {
            insert(target, div, anchor);
            append(div, t);
        },
        p(ctx, dirty) {
            if (dirty & 128 && t_value !== (t_value = ctx[11].text + "")) set_data(t, t_value);
            if (dirty & 128) {
                toggle_class(div, "completed", ctx[11].completed);
                toggle_class(div, "overflow", ctx[11].isOverflow);
                toggle_class(div, "range", ctx[11].isRangeEntry);
                toggle_class(div, "range-start", ctx[11].rangePosition === 'start');
                toggle_class(div, "range-middle", ctx[11].rangePosition === 'middle');
                toggle_class(div, "range-end", ctx[11].rangePosition === 'end');
            }
        },
        i: noop,
        o: noop,
        d(detaching) {
            if (detaching) detach(div);
        }
    };
}

function create_default_slot$1(ctx) {
    let div2;
    let div0;
    let t0_value = ctx[0].format("D") + "";
    let t0;
    let t1;
    let div1;
    let div2_class_value;
    let current;
    let mounted;
    let dispose;
    
    // Use entries instead of dots
    let each_value = (ctx[7].entries && ctx[7].entries.length > 0) ? ctx[7].entries : [];
    let each_blocks = [];

    for (let i = 0; i < each_value.length; i += 1) {
        each_blocks[i] = create_each_block$2(get_each_context$2(ctx, each_value, i));
    }

    let div2_levels = [
        { class: div2_class_value = `day ${ctx[7].classes.join(" ")}` },
        ctx[7].dataAttributes || {}
    ];

    let div2_data = {};

    for (let i = 0; i < div2_levels.length; i += 1) {
        div2_data = assign(div2_data, div2_levels[i]);
    }

    return {
        c() {
            div2 = element("div");
            div0 = element("div");
            t0 = text(t0_value);
            t1 = space();
            div1 = element("div");

            for (let i = 0; i < each_blocks.length; i += 1) {
                each_blocks[i].c();
            }

            attr(div0, "class", "day-number svelte-q3wqg9");
            attr(div1, "class", "entries-container svelte-q3wqg9");
            set_attributes(div2, div2_data);
            toggle_class(div2, "active", ctx[6] === getDateUID_1(ctx[0], "day"));
            toggle_class(div2, "adjacent-month", !ctx[0].isSame(ctx[5], "month"));
            toggle_class(div2, "today", ctx[0].isSame(ctx[4], "day"));
            toggle_class(div2, "svelte-q3wqg9", true);
        },
        m(target, anchor) {
            insert(target, div2, anchor);
            append(div2, div0);
            append(div0, t0);
            append(div2, t1);
            append(div2, div1);

            for (let i = 0; i < each_blocks.length; i += 1) {
                each_blocks[i].m(div1, null);
            }

            current = true;

            if (!mounted) {
                dispose = [
                    listen(div2, "click", function () {
                        if (is_function(ctx[2] && ctx[8])) (ctx[2] && ctx[8]).apply(this, arguments);
                    }),
                    listen(div2, "contextmenu", function () {
                        if (is_function(ctx[3] && ctx[9])) (ctx[3] && ctx[9]).apply(this, arguments);
                    }),
                    listen(div2, "pointerover", function () {
                        if (is_function(ctx[1] && ctx[10])) (ctx[1] && ctx[10]).apply(this, arguments);
                    })
                ];
                mounted = true;
            }
        },
        p(new_ctx, dirty) {
            ctx = new_ctx;
            if ((!current || dirty & 1) && t0_value !== (t0_value = ctx[0].format("D") + "")) set_data(t0, t0_value);

            if (dirty & 128) {
                each_value = (ctx[7].entries && ctx[7].entries.length > 0) ? ctx[7].entries : [];
                let i;

                for (i = 0; i < each_value.length; i += 1) {
                    const child_ctx = get_each_context$2(ctx, each_value, i);

                    if (each_blocks[i]) {
                        each_blocks[i].p(child_ctx, dirty);
                    } else {
                        each_blocks[i] = create_each_block$2(child_ctx);
                        each_blocks[i].c();
                        each_blocks[i].m(div1, null);
                    }
                }

                for (; i < each_blocks.length; i += 1) {
                    each_blocks[i].d(1);
                }
                each_blocks.length = each_value.length;
            }

            set_attributes(div2, div2_data = get_spread_update(div2_levels, [
                (!current || dirty & 128 && div2_class_value !== (div2_class_value = `day ${ctx[7].classes.join(" ")}`)) && { class: div2_class_value },
                dirty & 128 && (ctx[7].dataAttributes || {})
            ]));

            toggle_class(div2, "active", ctx[6] === getDateUID_1(ctx[0], "day"));
            toggle_class(div2, "adjacent-month", !ctx[0].isSame(ctx[5], "month"));
            toggle_class(div2, "today", ctx[0].isSame(ctx[4], "day"));
            toggle_class(div2, "svelte-q3wqg9", true);
        },
        i(local) {
            if (current) return;
            current = true;
        },
        o(local) {
            current = false;
        },
        d(detaching) {
            if (detaching) detach(div2);
            destroy_each(each_blocks, detaching);
            mounted = false;
            run_all(dispose);
        }
    };
}

function create_fragment$4(ctx) {
    let td;
    let metadataresolver;
    let current;

    metadataresolver = new MetadataResolver({
        props: {
            metadata: ctx[7],
            $$slots: {
                default: [
                    create_default_slot$1,
                    ({ metadata }) => ({ 7: metadata }),
                    ({ metadata }) => metadata ? 128 : 0
                ]
            },
            $$scope: { ctx }
        }
    });

    return {
        c() {
            td = element("td");
            create_component(metadataresolver.$$.fragment);
        },
        m(target, anchor) {
            insert(target, td, anchor);
            mount_component(metadataresolver, td, null);
            current = true;
        },
        p(ctx, [dirty]) {
            const metadataresolver_changes = {};
            if (dirty & 128) metadataresolver_changes.metadata = ctx[7];

            if (dirty & 16639) {
                metadataresolver_changes.$$scope = { dirty, ctx };
            }

            metadataresolver.$set(metadataresolver_changes);
        },
        i(local) {
            if (current) return;
            transition_in(metadataresolver.$$.fragment, local);
            current = true;
        },
        o(local) {
            transition_out(metadataresolver.$$.fragment, local);
            current = false;
        },
        d(detaching) {
            if (detaching) detach(td);
            destroy_component(metadataresolver);
        }
    };
}

function instance$4($$self, $$props, $$invalidate) {
    let { date } = $$props;
    let { metadata } = $$props;
    let { onHover } = $$props;
    let { onClick } = $$props;
    let { onContextMenu } = $$props;
    let { today } = $$props;
    let { displayedMonth = null } = $$props;
    let { selectedId = null } = $$props;
    const click_handler = e => onClick(date, isMetaPressed(e));
    const contextmenu_handler = e => onContextMenu(date, e);
    const pointerover_handler = e => onHover(date, e.target, isMetaPressed(e));

    $$self.$$set = $$props => {
        if ("date" in $$props) $$invalidate(0, date = $$props.date);
        if ("metadata" in $$props) $$invalidate(7, metadata = $$props.metadata);
        if ("onHover" in $$props) $$invalidate(1, onHover = $$props.onHover);
        if ("onClick" in $$props) $$invalidate(2, onClick = $$props.onClick);
        if ("onContextMenu" in $$props) $$invalidate(3, onContextMenu = $$props.onContextMenu);
        if ("today" in $$props) $$invalidate(4, today = $$props.today);
        if ("displayedMonth" in $$props) $$invalidate(5, displayedMonth = $$props.displayedMonth);
        if ("selectedId" in $$props) $$invalidate(6, selectedId = $$props.selectedId);
    };

    return [
        date,
        onHover,
        onClick,
        onContextMenu,
        today,
        displayedMonth,
        selectedId,
        metadata,
        click_handler,
        contextmenu_handler,
        pointerover_handler
    ];
}

class Day extends SvelteComponent {
    constructor(options) {
        super();
        if (!document.getElementById("svelte-q3wqg9-style")) add_css$4();

        init(this, options, instance$4, create_fragment$4, not_equal, {
            date: 0,
            metadata: 7,
            onHover: 1,
            onClick: 2,
            onContextMenu: 3,
            today: 4,
            displayedMonth: 5,
            selectedId: 6
        });
    }
}

// ============================================
// ARROW COMPONENT
// ============================================

function add_css$3() {
    var style = element("style");
    style.id = "svelte-156w7na-style";
    style.textContent = ".arrow.svelte-156w7na.svelte-156w7na{align-items:center;cursor:pointer;display:flex;justify-content:center;width:24px}.arrow.is-mobile.svelte-156w7na.svelte-156w7na{width:32px}.right.svelte-156w7na.svelte-156w7na{transform:rotate(180deg)}.arrow.svelte-156w7na svg.svelte-156w7na{color:var(--color-arrow);height:16px;width:16px}";
    append(document.head, style);
}

function create_fragment$3(ctx) {
    let div;
    let svg;
    let path;
    let mounted;
    let dispose;

    return {
        c() {
            div = element("div");
            svg = svg_element("svg");
            path = svg_element("path");
            attr(path, "fill", "currentColor");
            attr(path, "d", "M34.52 239.03L228.87 44.69c9.37-9.37 24.57-9.37 33.94 0l22.67 22.67c9.36 9.36 9.37 24.52.04 33.9L131.49 256l154.02 154.75c9.34 9.38 9.32 24.54-.04 33.9l-22.67 22.67c-9.37 9.37-24.57 9.37-33.94 0L34.52 272.97c-9.37-9.37-9.37-24.57 0-33.94z");
            attr(svg, "focusable", "false");
            attr(svg, "role", "img");
            attr(svg, "xmlns", "http://www.w3.org/2000/svg");
            attr(svg, "viewBox", "0 0 320 512");
            attr(svg, "class", "svelte-156w7na");
            attr(div, "class", "arrow svelte-156w7na");
            attr(div, "aria-label", ctx[1]);
            toggle_class(div, "is-mobile", ctx[3]);
            toggle_class(div, "right", ctx[2] === "right");
        },
        m(target, anchor) {
            insert(target, div, anchor);
            append(div, svg);
            append(svg, path);

            if (!mounted) {
                dispose = listen(div, "click", function () {
                    if (is_function(ctx[0])) ctx[0].apply(this, arguments);
                });
                mounted = true;
            }
        },
        p(new_ctx, [dirty]) {
            ctx = new_ctx;
            if (dirty & 2) {
                attr(div, "aria-label", ctx[1]);
            }
            if (dirty & 4) {
                toggle_class(div, "right", ctx[2] === "right");
            }
        },
        i: noop,
        o: noop,
        d(detaching) {
            if (detaching) detach(div);
            mounted = false;
            dispose();
        }
    };
}

function instance$3($$self, $$props, $$invalidate) {
    let { onClick } = $$props;
    let { tooltip } = $$props;
    let { direction } = $$props;
    let isMobile = window.app.isMobile;

    $$self.$$set = $$props => {
        if ("onClick" in $$props) $$invalidate(0, onClick = $$props.onClick);
        if ("tooltip" in $$props) $$invalidate(1, tooltip = $$props.tooltip);
        if ("direction" in $$props) $$invalidate(2, direction = $$props.direction);
    };

    return [onClick, tooltip, direction, isMobile];
}

class Arrow extends SvelteComponent {
    constructor(options) {
        super();
        if (!document.getElementById("svelte-156w7na-style")) add_css$3();
        init(this, options, instance$3, create_fragment$3, safe_not_equal, { onClick: 0, tooltip: 1, direction: 2 });
    }
}

// ============================================
// NAV COMPONENT
// ============================================

function add_css$2() {
    var style = element("style");
    style.id = "svelte-1vwr9dd-style";
    style.textContent = ".nav.svelte-1vwr9dd.svelte-1vwr9dd{align-items:center;display:flex;margin:0.6em 0 1em;padding:0 8px;width:100%}.nav.is-mobile.svelte-1vwr9dd.svelte-1vwr9dd{padding:0}.title.svelte-1vwr9dd.svelte-1vwr9dd{color:var(--color-text-title);font-size:1.5em;margin:0}.is-mobile.svelte-1vwr9dd .title.svelte-1vwr9dd{font-size:1.3em}.month.svelte-1vwr9dd.svelte-1vwr9dd{font-weight:500;text-transform:capitalize}.year.svelte-1vwr9dd.svelte-1vwr9dd{color:var(--interactive-accent)}.right-nav.svelte-1vwr9dd.svelte-1vwr9dd{display:flex;justify-content:center;margin-left:auto}.reset-button.svelte-1vwr9dd.svelte-1vwr9dd{cursor:pointer;border-radius:4px;color:var(--text-muted);font-size:0.7em;font-weight:600;letter-spacing:1px;margin:0 4px;padding:0px 4px;text-transform:uppercase}.is-mobile.svelte-1vwr9dd .reset-button.svelte-1vwr9dd{display:none}";
    append(document.head, style);
}

function create_fragment$2(ctx) {
    let div2;
    let h3;
    let span0;
    let t0_value = ctx[0].format("MMM") + "";
    let t0;
    let t1;
    let span1;
    let t2_value = ctx[0].format("YYYY") + "";
    let t2;
    let t3;
    let div1;
    let arrow0;
    let t4;
    let div0;
    let t6;
    let arrow1;
    let current;
    let mounted;
    let dispose;

    arrow0 = new Arrow({
        props: {
            direction: "left",
            onClick: ctx[3],
            tooltip: "Previous Month"
        }
    });

    arrow1 = new Arrow({
        props: {
            direction: "right",
            onClick: ctx[2],
            tooltip: "Next Month"
        }
    });

    return {
        c() {
            div2 = element("div");
            h3 = element("h3");
            span0 = element("span");
            t0 = text(t0_value);
            t1 = space();
            span1 = element("span");
            t2 = text(t2_value);
            t3 = space();
            div1 = element("div");
            create_component(arrow0.$$.fragment);
            t4 = space();
            div0 = element("div");
            div0.textContent = `${ctx[4]}`;
            t6 = space();
            create_component(arrow1.$$.fragment);
            attr(span0, "class", "month svelte-1vwr9dd");
            attr(span1, "class", "year svelte-1vwr9dd");
            attr(h3, "class", "title svelte-1vwr9dd");
            attr(div0, "class", "reset-button svelte-1vwr9dd");
            attr(div1, "class", "right-nav svelte-1vwr9dd");
            attr(div2, "class", "nav svelte-1vwr9dd");
            toggle_class(div2, "is-mobile", ctx[5]);
        },
        m(target, anchor) {
            insert(target, div2, anchor);
            append(div2, h3);
            append(h3, span0);
            append(span0, t0);
            append(h3, t1);
            append(h3, span1);
            append(span1, t2);
            append(div2, t3);
            append(div2, div1);
            mount_component(arrow0, div1, null);
            append(div1, t4);
            append(div1, div0);
            append(div1, t6);
            mount_component(arrow1, div1, null);
            current = true;

            if (!mounted) {
                dispose = [
                    listen(h3, "click", function () {
                        if (is_function(ctx[1])) ctx[1].apply(this, arguments);
                    }),
                    listen(div0, "click", function () {
                        if (is_function(ctx[1])) ctx[1].apply(this, arguments);
                    })
                ];
                mounted = true;
            }
        },
        p(new_ctx, [dirty]) {
            ctx = new_ctx;
            if ((!current || dirty & 1) && t0_value !== (t0_value = ctx[0].format("MMM") + "")) set_data(t0, t0_value);
            if ((!current || dirty & 1) && t2_value !== (t2_value = ctx[0].format("YYYY") + "")) set_data(t2, t2_value);
            const arrow0_changes = {};
            if (dirty & 8) arrow0_changes.onClick = ctx[3];
            arrow0.$set(arrow0_changes);
            const arrow1_changes = {};
            if (dirty & 4) arrow1_changes.onClick = ctx[2];
            arrow1.$set(arrow1_changes);
        },
        i(local) {
            if (current) return;
            transition_in(arrow0.$$.fragment, local);
            transition_in(arrow1.$$.fragment, local);
            current = true;
        },
        o(local) {
            transition_out(arrow0.$$.fragment, local);
            transition_out(arrow1.$$.fragment, local);
            current = false;
        },
        d(detaching) {
            if (detaching) detach(div2);
            destroy_component(arrow0);
            destroy_component(arrow1);
            mounted = false;
            run_all(dispose);
        }
    };
}

function instance$2($$self, $$props, $$invalidate) {
    let { displayedMonth } = $$props;
    let { today } = $$props;
    let { resetDisplayedMonth } = $$props;
    let { incrementDisplayedMonth } = $$props;
    let { decrementDisplayedMonth } = $$props;
    const todayDisplayStr = today.calendar().split(/\d|\s/)[0];
    let isMobile = window.app.isMobile;

    $$self.$$set = $$props => {
        if ("displayedMonth" in $$props) $$invalidate(0, displayedMonth = $$props.displayedMonth);
        if ("today" in $$props) $$invalidate(6, today = $$props.today);
        if ("resetDisplayedMonth" in $$props) $$invalidate(1, resetDisplayedMonth = $$props.resetDisplayedMonth);
        if ("incrementDisplayedMonth" in $$props) $$invalidate(2, incrementDisplayedMonth = $$props.incrementDisplayedMonth);
        if ("decrementDisplayedMonth" in $$props) $$invalidate(3, decrementDisplayedMonth = $$props.decrementDisplayedMonth);
    };

    return [
        displayedMonth,
        resetDisplayedMonth,
        incrementDisplayedMonth,
        decrementDisplayedMonth,
        todayDisplayStr,
        isMobile,
        today
    ];
}

class Nav extends SvelteComponent {
    constructor(options) {
        super();
        if (!document.getElementById("svelte-1vwr9dd-style")) add_css$2();

        init(this, options, instance$2, create_fragment$2, safe_not_equal, {
            displayedMonth: 0,
            today: 6,
            resetDisplayedMonth: 1,
            incrementDisplayedMonth: 2,
            decrementDisplayedMonth: 3
        });
    }
}

// ============================================
// WEEK NUM COMPONENT
// ============================================

function add_css$1() {
    var style = element("style");
    style.id = "svelte-egt0yd-style";
    style.textContent = "td.svelte-egt0yd{border-right:1px solid var(--background-modifier-border)}.week-num.svelte-egt0yd{background-color:var(--color-background-weeknum);border-radius:4px;color:var(--color-text-weeknum);cursor:pointer;font-size:0.65em;height:100%;padding:4px;text-align:center;transition:background-color 0.1s ease-in, color 0.1s ease-in;vertical-align:baseline}.week-num.svelte-egt0yd:hover{background-color:var(--interactive-hover)}.week-num.active.svelte-egt0yd:hover{background-color:var(--interactive-accent-hover)}.active.svelte-egt0yd{color:var(--text-on-accent);background-color:var(--interactive-accent)}.dot-container.svelte-egt0yd{display:flex;flex-wrap:wrap;justify-content:center;line-height:6px;min-height:6px}";
    append(document.head, style);
}

function get_each_context$1(ctx, list, i) {
    const child_ctx = ctx.slice();
    child_ctx[11] = list[i];
    return child_ctx;
}

function create_each_block$1(ctx) {
    let dot;
    let current;
    const dot_spread_levels = [ctx[11]];
    let dot_props = {};

    for (let i = 0; i < dot_spread_levels.length; i += 1) {
        dot_props = assign(dot_props, dot_spread_levels[i]);
    }

    dot = new Dot({ props: dot_props });

    return {
        c() {
            create_component(dot.$$.fragment);
        },
        m(target, anchor) {
            mount_component(dot, target, anchor);
            current = true;
        },
        p(ctx, dirty) {
            const dot_changes = (dirty & 64)
                ? get_spread_update(dot_spread_levels, [get_spread_object(ctx[11])])
                : {};
            dot.$set(dot_changes);
        },
        i(local) {
            if (current) return;
            transition_in(dot.$$.fragment, local);
            current = true;
        },
        o(local) {
            transition_out(dot.$$.fragment, local);
            current = false;
        },
        d(detaching) {
            destroy_component(dot, detaching);
        }
    };
}

function create_default_slot(ctx) {
    let div1;
    let t0;
    let t1;
    let div0;
    let div1_class_value;
    let current;
    let mounted;
    let dispose;
    let each_value = ctx[6].dots;
    let each_blocks = [];

    for (let i = 0; i < each_value.length; i += 1) {
        each_blocks[i] = create_each_block$1(get_each_context$1(ctx, each_value, i));
    }

    const out = i => transition_out(each_blocks[i], 1, 1, () => {
        each_blocks[i] = null;
    });

    return {
        c() {
            div1 = element("div");
            t0 = text(ctx[0]);
            t1 = space();
            div0 = element("div");

            for (let i = 0; i < each_blocks.length; i += 1) {
                each_blocks[i].c();
            }

            attr(div0, "class", "dot-container svelte-egt0yd");
            attr(div1, "class", div1_class_value = "" + (null_to_empty(`week-num ${ctx[6].classes.join(" ")}`) + " svelte-egt0yd"));
            toggle_class(div1, "active", ctx[5] === getDateUID_1(ctx[1][0], "week"));
        },
        m(target, anchor) {
            insert(target, div1, anchor);
            append(div1, t0);
            append(div1, t1);
            append(div1, div0);

            for (let i = 0; i < each_blocks.length; i += 1) {
                each_blocks[i].m(div0, null);
            }

            current = true;

            if (!mounted) {
                dispose = [
                    listen(div1, "click", function () {
                        if (is_function(ctx[3] && ctx[8])) (ctx[3] && ctx[8]).apply(this, arguments);
                    }),
                    listen(div1, "contextmenu", function () {
                        if (is_function(ctx[4] && ctx[9])) (ctx[4] && ctx[9]).apply(this, arguments);
                    }),
                    listen(div1, "pointerover", function () {
                        if (is_function(ctx[2] && ctx[10])) (ctx[2] && ctx[10]).apply(this, arguments);
                    })
                ];
                mounted = true;
            }
        },
        p(new_ctx, dirty) {
            ctx = new_ctx;
            if (!current || dirty & 1) set_data(t0, ctx[0]);

            if (dirty & 64) {
                each_value = ctx[6].dots;
                let i;

                for (i = 0; i < each_value.length; i += 1) {
                    const child_ctx = get_each_context$1(ctx, each_value, i);

                    if (each_blocks[i]) {
                        each_blocks[i].p(child_ctx, dirty);
                        transition_in(each_blocks[i], 1);
                    } else {
                        each_blocks[i] = create_each_block$1(child_ctx);
                        each_blocks[i].c();
                        transition_in(each_blocks[i], 1);
                        each_blocks[i].m(div0, null);
                    }
                }

                group_outros();
                for (i = each_value.length; i < each_blocks.length; i += 1) {
                    out(i);
                }
                check_outros();
            }

            if (!current || dirty & 64 && div1_class_value !== (div1_class_value = "" + (null_to_empty(`week-num ${ctx[6].classes.join(" ")}`) + " svelte-egt0yd"))) {
                attr(div1, "class", div1_class_value);
            }

            if (dirty & 98) {
                toggle_class(div1, "active", ctx[5] === getDateUID_1(ctx[1][0], "week"));
            }
        },
        i(local) {
            if (current) return;
            for (let i = 0; i < each_value.length; i += 1) {
                transition_in(each_blocks[i]);
            }
            current = true;
        },
        o(local) {
            each_blocks = each_blocks.filter(Boolean);
            for (let i = 0; i < each_blocks.length; i += 1) {
                transition_out(each_blocks[i]);
            }
            current = false;
        },
        d(detaching) {
            if (detaching) detach(div1);
            destroy_each(each_blocks, detaching);
            mounted = false;
            run_all(dispose);
        }
    };
}

function create_fragment$1(ctx) {
    let td;
    let metadataresolver;
    let current;

    metadataresolver = new MetadataResolver({
        props: {
            metadata: ctx[6],
            $$slots: {
                default: [
                    create_default_slot,
                    ({ metadata }) => ({ 6: metadata }),
                    ({ metadata }) => metadata ? 64 : 0
                ]
            },
            $$scope: { ctx }
        }
    });

    return {
        c() {
            td = element("td");
            create_component(metadataresolver.$$.fragment);
            attr(td, "class", "svelte-egt0yd");
        },
        m(target, anchor) {
            insert(target, td, anchor);
            mount_component(metadataresolver, td, null);
            current = true;
        },
        p(ctx, [dirty]) {
            const metadataresolver_changes = {};
            if (dirty & 64) metadataresolver_changes.metadata = ctx[6];

            if (dirty & 16639) {
                metadataresolver_changes.$$scope = { dirty, ctx };
            }

            metadataresolver.$set(metadataresolver_changes);
        },
        i(local) {
            if (current) return;
            transition_in(metadataresolver.$$.fragment, local);
            current = true;
        },
        o(local) {
            transition_out(metadataresolver.$$.fragment, local);
            current = false;
        },
        d(detaching) {
            if (detaching) detach(td);
            destroy_component(metadataresolver);
        }
    };
}

function instance$1($$self, $$props, $$invalidate) {
    let { weekNum } = $$props;
    let { days } = $$props;
    let { metadata } = $$props;
    let { onHover } = $$props;
    let { onClick } = $$props;
    let { onContextMenu } = $$props;
    let { selectedId = null } = $$props;
    let startOfWeek;
    const click_handler = e => onClick(startOfWeek, isMetaPressed(e));
    const contextmenu_handler = e => onContextMenu(days[0], e);
    const pointerover_handler = e => onHover(startOfWeek, e.target, isMetaPressed(e));

    $$self.$$set = $$props => {
        if ("weekNum" in $$props) $$invalidate(0, weekNum = $$props.weekNum);
        if ("days" in $$props) $$invalidate(1, days = $$props.days);
        if ("metadata" in $$props) $$invalidate(6, metadata = $$props.metadata);
        if ("onHover" in $$props) $$invalidate(2, onHover = $$props.onHover);
        if ("onClick" in $$props) $$invalidate(3, onClick = $$props.onClick);
        if ("onContextMenu" in $$props) $$invalidate(4, onContextMenu = $$props.onContextMenu);
        if ("selectedId" in $$props) $$invalidate(5, selectedId = $$props.selectedId);
    };

    $$self.$$.update = () => {
        if ($$self.$$.dirty & 2) {
            $$invalidate(7, startOfWeek = getStartOfWeek(days));
        }
    };

    return [
        weekNum,
        days,
        onHover,
        onClick,
        onContextMenu,
        selectedId,
        metadata,
        startOfWeek,
        click_handler,
        contextmenu_handler,
        pointerover_handler
    ];
}

class WeekNum extends SvelteComponent {
    constructor(options) {
        super();
        if (!document.getElementById("svelte-egt0yd-style")) add_css$1();

        init(this, options, instance$1, create_fragment$1, not_equal, {
            weekNum: 0,
            days: 1,
            metadata: 6,
            onHover: 2,
            onClick: 3,
            onContextMenu: 4,
            selectedId: 5
        });
    }
}

// ============================================
// MAIN CALENDAR COMPONENT
// ============================================

function add_css() {
    var style = element("style");
    style.id = "svelte-pcimu8-style";
    style.textContent = ".container.svelte-pcimu8{--color-background-heading:transparent;--color-background-day:transparent;--color-background-weeknum:transparent;--color-background-weekend:transparent;--color-dot:var(--text-muted);--color-arrow:var(--text-muted);--color-button:var(--text-muted);--color-text-title:var(--text-normal);--color-text-heading:var(--text-muted);--color-text-day:var(--text-normal);--color-text-today:var(--interactive-accent);--color-text-weeknum:var(--text-muted)}.container.svelte-pcimu8{padding:0 8px}.container.is-mobile.svelte-pcimu8{padding:0}th.svelte-pcimu8{text-align:center}.weekend.svelte-pcimu8{background-color:var(--color-background-weekend)}.calendar.svelte-pcimu8{border-collapse:collapse;width:100%}th.svelte-pcimu8{background-color:var(--color-background-heading);color:var(--color-text-heading);font-size:0.6em;letter-spacing:1px;padding:4px;text-transform:uppercase}";
    append(document.head, style);
}

function get_each_context(ctx, list, i) {
    const child_ctx = ctx.slice();
    child_ctx[18] = list[i];
    return child_ctx;
}

function get_each_context_1(ctx, list, i) {
    const child_ctx = ctx.slice();
    child_ctx[21] = list[i];
    return child_ctx;
}

function get_each_context_2(ctx, list, i) {
    const child_ctx = ctx.slice();
    child_ctx[24] = list[i];
    return child_ctx;
}

function get_each_context_3(ctx, list, i) {
    const child_ctx = ctx.slice();
    child_ctx[27] = list[i];
    return child_ctx;
}

function create_if_block_2(ctx) {
    let col;
    return {
        c() { col = element("col"); },
        m(target, anchor) { insert(target, col, anchor); },
        d(detaching) { if (detaching) detach(col); }
    };
}

function create_each_block_3(ctx) {
    let col;
    return {
        c() {
            col = element("col");
            attr(col, "class", "svelte-pcimu8");
            toggle_class(col, "weekend", isWeekend(ctx[27]));
        },
        m(target, anchor) { insert(target, col, anchor); },
        p(ctx, dirty) {
            if (dirty & 16384) {
                toggle_class(col, "weekend", isWeekend(ctx[27]));
            }
        },
        d(detaching) { if (detaching) detach(col); }
    };
}

function create_if_block_1(ctx) {
    let th;
    return {
        c() {
            th = element("th");
            th.textContent = "W";
            attr(th, "class", "svelte-pcimu8");
        },
        m(target, anchor) { insert(target, th, anchor); },
        d(detaching) { if (detaching) detach(th); }
    };
}

function create_each_block_2(ctx) {
    let th;
    let t_value = ctx[24] + "";
    let t;

    return {
        c() {
            th = element("th");
            t = text(t_value);
            attr(th, "class", "svelte-pcimu8");
        },
        m(target, anchor) {
            insert(target, th, anchor);
            append(th, t);
        },
        p(ctx, dirty) {
            if (dirty & 32768 && t_value !== (t_value = ctx[24] + "")) set_data(t, t_value);
        },
        d(detaching) { if (detaching) detach(th); }
    };
}

function create_if_block(ctx) {
    let weeknum;
    let current;

    const weeknum_spread_levels = [
        ctx[18],
        {
            metadata: getWeeklyMetadata(ctx[8], ctx[18].days[0], ctx[10])
        },
        { onClick: ctx[7] },
        { onContextMenu: ctx[5] },
        { onHover: ctx[3] },
        { selectedId: ctx[9] }
    ];

    let weeknum_props = {};
    for (let i = 0; i < weeknum_spread_levels.length; i += 1) {
        weeknum_props = assign(weeknum_props, weeknum_spread_levels[i]);
    }

    weeknum = new WeekNum({ props: weeknum_props });

    return {
        c() { create_component(weeknum.$$.fragment); },
        m(target, anchor) { mount_component(weeknum, target, anchor); current = true; },
        p(ctx, dirty) {
            const weeknum_changes = (dirty & 18344)
                ? get_spread_update(weeknum_spread_levels, [
                    dirty & 16384 && get_spread_object(ctx[18]),
                    dirty & 17664 && { metadata: getWeeklyMetadata(ctx[8], ctx[18].days[0], ctx[10]) },
                    dirty & 128 && { onClick: ctx[7] },
                    dirty & 32 && { onContextMenu: ctx[5] },
                    dirty & 8 && { onHover: ctx[3] },
                    dirty & 512 && { selectedId: ctx[9] }
                ])
                : {};
            weeknum.$set(weeknum_changes);
        },
        i(local) { if (current) return; transition_in(weeknum.$$.fragment, local); current = true; },
        o(local) { transition_out(weeknum.$$.fragment, local); current = false; },
        d(detaching) { destroy_component(weeknum, detaching); }
    };
}

function create_each_block_1(key_1, ctx) {
    let first;
    let day;
    let current;

    day = new Day({
        props: {
            date: ctx[21],
            today: ctx[10],
            displayedMonth: ctx[0],
            onClick: ctx[6],
            onContextMenu: ctx[4],
            onHover: ctx[2],
            metadata: getDailyMetadata(ctx[8], ctx[21], ctx[10]),
            selectedId: ctx[9]
        }
    });

    return {
        key: key_1,
        first: null,
        c() {
            first = empty();
            create_component(day.$$.fragment);
            this.first = first;
        },
        m(target, anchor) {
            insert(target, first, anchor);
            mount_component(day, target, anchor);
            current = true;
        },
        p(new_ctx, dirty) {
            ctx = new_ctx;
            const day_changes = {};
            if (dirty & 16384) day_changes.date = ctx[21];
            if (dirty & 1024) day_changes.today = ctx[10];
            if (dirty & 1) day_changes.displayedMonth = ctx[0];
            if (dirty & 64) day_changes.onClick = ctx[6];
            if (dirty & 16) day_changes.onContextMenu = ctx[4];
            if (dirty & 4) day_changes.onHover = ctx[2];
            if (dirty & 17664) day_changes.metadata = getDailyMetadata(ctx[8], ctx[21], ctx[10]);
            if (dirty & 512) day_changes.selectedId = ctx[9];
            day.$set(day_changes);
        },
        i(local) { if (current) return; transition_in(day.$$.fragment, local); current = true; },
        o(local) { transition_out(day.$$.fragment, local); current = false; },
        d(detaching) { if (detaching) detach(first); destroy_component(day, detaching); }
    };
}

function create_each_block(key_1, ctx) {
    let tr;
    let t0;
    let each_blocks = [];
    let each_1_lookup = new Map();
    let t1;
    let current;
    let if_block = ctx[1] && create_if_block(ctx);
    let each_value_1 = ctx[18].days;
    const get_key = ctx => ctx[21].format();

    for (let i = 0; i < each_value_1.length; i += 1) {
        let child_ctx = get_each_context_1(ctx, each_value_1, i);
        let key = get_key(child_ctx);
        each_1_lookup.set(key, each_blocks[i] = create_each_block_1(key, child_ctx));
    }

    return {
        key: key_1,
        first: null,
        c() {
            tr = element("tr");
            if (if_block) if_block.c();
            t0 = space();
            for (let i = 0; i < each_blocks.length; i += 1) { each_blocks[i].c(); }
            t1 = space();
            this.first = tr;
        },
        m(target, anchor) {
            insert(target, tr, anchor);
            if (if_block) if_block.m(tr, null);
            append(tr, t0);
            for (let i = 0; i < each_blocks.length; i += 1) { each_blocks[i].m(tr, null); }
            append(tr, t1);
            current = true;
        },
        p(new_ctx, dirty) {
            ctx = new_ctx;

            if (ctx[1]) {
                if (if_block) {
                    if_block.p(ctx, dirty);
                    if (dirty & 2) { transition_in(if_block, 1); }
                } else {
                    if_block = create_if_block(ctx);
                    if_block.c();
                    transition_in(if_block, 1);
                    if_block.m(tr, t0);
                }
            } else if (if_block) {
                group_outros();
                transition_out(if_block, 1, 1, () => { if_block = null; });
                check_outros();
            }

            if (dirty & 18261) {
                each_value_1 = ctx[18].days;
                group_outros();
                each_blocks = update_keyed_each(each_blocks, dirty, get_key, 1, ctx, each_value_1, each_1_lookup, tr, outro_and_destroy_block, create_each_block_1, t1, get_each_context_1);
                check_outros();
            }
        },
        i(local) {
            if (current) return;
            transition_in(if_block);
            for (let i = 0; i < each_value_1.length; i += 1) { transition_in(each_blocks[i]); }
            current = true;
        },
        o(local) {
            transition_out(if_block);
            for (let i = 0; i < each_blocks.length; i += 1) { transition_out(each_blocks[i]); }
            current = false;
        },
        d(detaching) {
            if (detaching) detach(tr);
            if (if_block) if_block.d();
            for (let i = 0; i < each_blocks.length; i += 1) { each_blocks[i].d(); }
        }
    };
}

function create_fragment$7(ctx) {
    let div;
    let nav;
    let t0;
    let table;
    let colgroup;
    let t1;
    let t2;
    let thead;
    let tr;
    let t3;
    let t4;
    let tbody;
    let each_blocks = [];
    let each2_lookup = new Map();
    let current;

    nav = new Nav({
        props: {
            today: ctx[10],
            displayedMonth: ctx[0],
            incrementDisplayedMonth: ctx[11],
            decrementDisplayedMonth: ctx[12],
            resetDisplayedMonth: ctx[13]
        }
    });

    let if_block0 = ctx[1] && create_if_block_2();
    let each_value_3 = ctx[14][1].days;
    let each_blocks_2 = [];

    for (let i = 0; i < each_value_3.length; i += 1) {
        each_blocks_2[i] = create_each_block_3(get_each_context_3(ctx, each_value_3, i));
    }

    let if_block1 = ctx[1] && create_if_block_1();
    let each_value_2 = ctx[15];
    let each_blocks_1 = [];

    for (let i = 0; i < each_value_2.length; i += 1) {
        each_blocks_1[i] = create_each_block_2(get_each_context_2(ctx, each_value_2, i));
    }

    let each_value = ctx[14];
    const get_key = ctx => ctx[18].weekNum;

    for (let i = 0; i < each_value.length; i += 1) {
        let child_ctx = get_each_context(ctx, each_value, i);
        let key = get_key(child_ctx);
        each2_lookup.set(key, each_blocks[i] = create_each_block(key, child_ctx));
    }

    return {
        c() {
            div = element("div");
            create_component(nav.$$.fragment);
            t0 = space();
            table = element("table");
            colgroup = element("colgroup");
            if (if_block0) if_block0.c();
            t1 = space();
            for (let i = 0; i < each_blocks_2.length; i += 1) { each_blocks_2[i].c(); }
            t2 = space();
            thead = element("thead");
            tr = element("tr");
            if (if_block1) if_block1.c();
            t3 = space();
            for (let i = 0; i < each_blocks_1.length; i += 1) { each_blocks_1[i].c(); }
            t4 = space();
            tbody = element("tbody");
            for (let i = 0; i < each_blocks.length; i += 1) { each_blocks[i].c(); }
            attr(table, "class", "calendar svelte-pcimu8");
            attr(div, "id", "calendar-container");
            attr(div, "class", "container svelte-pcimu8");
            toggle_class(div, "is-mobile", ctx[16]);
        },
        m(target, anchor) {
            insert(target, div, anchor);
            mount_component(nav, div, null);
            append(div, t0);
            append(div, table);
            append(table, colgroup);
            if (if_block0) if_block0.m(colgroup, null);
            append(colgroup, t1);
            for (let i = 0; i < each_blocks_2.length; i += 1) { each_blocks_2[i].m(colgroup, null); }
            append(table, t2);
            append(table, thead);
            append(thead, tr);
            if (if_block1) if_block1.m(tr, null);
            append(tr, t3);
            for (let i = 0; i < each_blocks_1.length; i += 1) { each_blocks_1[i].m(tr, null); }
            append(table, t4);
            append(table, tbody);
            for (let i = 0; i < each_blocks.length; i += 1) { each_blocks[i].m(tbody, null); }
            current = true;
        },
        p(ctx, [dirty]) {
            const nav_changes = {};
            if (dirty & 1024) nav_changes.today = ctx[10];
            if (dirty & 1) nav_changes.displayedMonth = ctx[0];
            nav.$set(nav_changes);

            if (ctx[1]) {
                if (if_block0) ; else {
                    if_block0 = create_if_block_2();
                    if_block0.c();
                    if_block0.m(colgroup, t1);
                }
            } else if (if_block0) {
                if_block0.d(1);
                if_block0 = null;
            }

            if (dirty & 16384) {
                each_value_3 = ctx[14][1].days;
                let i;
                for (i = 0; i < each_value_3.length; i += 1) {
                    const child_ctx = get_each_context_3(ctx, each_value_3, i);
                    if (each_blocks_2[i]) {
                        each_blocks_2[i].p(child_ctx, dirty);
                    } else {
                        each_blocks_2[i] = create_each_block_3(child_ctx);
                        each_blocks_2[i].c();
                        each_blocks_2[i].m(colgroup, null);
                    }
                }
                for (; i < each_blocks_2.length; i += 1) { each_blocks_2[i].d(1); }
                each_blocks_2.length = each_value_3.length;
            }

            if (ctx[1]) {
                if (if_block1) ; else {
                    if_block1 = create_if_block_1();
                    if_block1.c();
                    if_block1.m(tr, t3);
                }
            } else if (if_block1) {
                if_block1.d(1);
                if_block1 = null;
            }

            if (dirty & 32768) {
                each_value_2 = ctx[15];
                let i;
                for (i = 0; i < each_value_2.length; i += 1) {
                    const child_ctx = get_each_context_2(ctx, each_value_2, i);
                    if (each_blocks_1[i]) {
                        each_blocks_1[i].p(child_ctx, dirty);
                    } else {
                        each_blocks_1[i] = create_each_block_2(child_ctx);
                        each_blocks_1[i].c();
                        each_blocks_1[i].m(tr, null);
                    }
                }
                for (; i < each_blocks_1.length; i += 1) { each_blocks_1[i].d(1); }
                each_blocks_1.length = each_value_2.length;
            }

            if (dirty & 18431) {
                each_value = ctx[14];
                group_outros();
                each_blocks = update_keyed_each(each_blocks, dirty, get_key, 1, ctx, each_value, each2_lookup, tbody, outro_and_destroy_block, create_each_block, null, get_each_context);
                check_outros();
            }
        },
        i(local) {
            if (current) return;
            transition_in(nav.$$.fragment, local);
            for (let i = 0; i < each_value.length; i += 1) { transition_in(each_blocks[i]); }
            current = true;
        },
        o(local) {
            transition_out(nav.$$.fragment, local);
            for (let i = 0; i < each_blocks.length; i += 1) { transition_out(each_blocks[i]); }
            current = false;
        },
        d(detaching) {
            if (detaching) detach(div);
            destroy_component(nav);
            if (if_block0) if_block0.d();
            destroy_each(each_blocks_2, detaching);
            if (if_block1) if_block1.d();
            destroy_each(each_blocks_1, detaching);
            for (let i = 0; i < each_blocks.length; i += 1) { each_blocks[i].d(); }
        }
    };
}

function instance$7($$self, $$props, $$invalidate) {
    let { localeData } = $$props;
    let { showWeekNums = false } = $$props;
    let { onHoverDay } = $$props;
    let { onHoverWeek } = $$props;
    let { onContextMenuDay } = $$props;
    let { onContextMenuWeek } = $$props;
    let { onClickDay } = $$props;
    let { onClickWeek } = $$props;
    let { sources = [] } = $$props;
    let { selectedId } = $$props;
    let { today = window.moment() } = $$props;
    let { displayedMonth = today } = $$props;
    let month;
    let daysOfWeek;
    let isMobile = window.app.isMobile;

    function incrementDisplayedMonth() {
        $$invalidate(0, displayedMonth = displayedMonth.clone().add(1, "month"));
    }

    function decrementDisplayedMonth() {
        $$invalidate(0, displayedMonth = displayedMonth.clone().subtract(1, "month"));
    }

    function resetDisplayedMonth() {
        $$invalidate(0, displayedMonth = today.clone());
    }

    $$self.$$set = $$props => {
        if ("localeData" in $$props) $$invalidate(17, localeData = $$props.localeData);
        if ("showWeekNums" in $$props) $$invalidate(1, showWeekNums = $$props.showWeekNums);
        if ("onHoverDay" in $$props) $$invalidate(2, onHoverDay = $$props.onHoverDay);
        if ("onHoverWeek" in $$props) $$invalidate(3, onHoverWeek = $$props.onHoverWeek);
        if ("onContextMenuDay" in $$props) $$invalidate(4, onContextMenuDay = $$props.onContextMenuDay);
        if ("onContextMenuWeek" in $$props) $$invalidate(5, onContextMenuWeek = $$props.onContextMenuWeek);
        if ("onClickDay" in $$props) $$invalidate(6, onClickDay = $$props.onClickDay);
        if ("onClickWeek" in $$props) $$invalidate(7, onClickWeek = $$props.onClickWeek);
        if ("sources" in $$props) $$invalidate(8, sources = $$props.sources);
        if ("selectedId" in $$props) $$invalidate(9, selectedId = $$props.selectedId);
        if ("today" in $$props) $$invalidate(10, today = $$props.today);
        if ("displayedMonth" in $$props) $$invalidate(0, displayedMonth = $$props.displayedMonth);
    };

    $$self.$$.update = () => {
        if ($$self.$$.dirty & 131073) {
            $$invalidate(14, month = getMonth(displayedMonth, localeData));
        }
        if ($$self.$$.dirty & 132096) {
            $$invalidate(15, daysOfWeek = getDaysOfWeek(today, localeData));
        }
    };

    return [
        displayedMonth,
        showWeekNums,
        onHoverDay,
        onHoverWeek,
        onContextMenuDay,
        onContextMenuWeek,
        onClickDay,
        onClickWeek,
        sources,
        selectedId,
        today,
        incrementDisplayedMonth,
        decrementDisplayedMonth,
        resetDisplayedMonth,
        month,
        daysOfWeek,
        isMobile,
        localeData
    ];
}

class Calendar$1 extends SvelteComponent {
    constructor(options) {
        super();
        if (!document.getElementById("svelte-pcimu8-style")) add_css();

        init(this, options, instance$7, create_fragment$7, not_equal, {
            localeData: 17,
            showWeekNums: 1,
            onHoverDay: 2,
            onHoverWeek: 3,
            onContextMenuDay: 4,
            onContextMenuWeek: 5,
            onClickDay: 6,
            onClickWeek: 7,
            sources: 8,
            selectedId: 9,
            today: 10,
            displayedMonth: 0,
            incrementDisplayedMonth: 11,
            decrementDisplayedMonth: 12,
            resetDisplayedMonth: 13
        });
    }

    get incrementDisplayedMonth() { return this.$$.ctx[11]; }
    get decrementDisplayedMonth() { return this.$$.ctx[12]; }
    get resetDisplayedMonth() { return this.$$.ctx[13]; }
}

// ============================================
// LOCALE CONFIGURATION
// ============================================

const langToMomentLocale = {
    en: "en-gb",
    zh: "zh-cn",
    "zh-TW": "zh-tw",
    ru: "ru",
    ko: "ko",
    it: "it",
    id: "id",
    ro: "ro",
    "pt-BR": "pt-br",
    cz: "cs",
    da: "da",
    de: "de",
    es: "es",
    fr: "fr",
    no: "nn",
    pl: "pl",
    pt: "pt",
    tr: "tr",
    hi: "hi",
    nl: "nl",
    ar: "ar",
    ja: "ja",
};

const weekdays = [
    "sunday",
    "monday",
    "tuesday",
    "wednesday",
    "thursday",
    "friday",
    "saturday",
];

function overrideGlobalMomentWeekStart(weekStart) {
    const { moment } = window;
    const currentLocale = moment.locale();
    if (!window._bundledLocaleWeekSpec) {
        window._bundledLocaleWeekSpec = moment.localeData()._week;
    }
    if (weekStart === "locale") {
        moment.updateLocale(currentLocale, {
            week: window._bundledLocaleWeekSpec,
        });
    } else {
        moment.updateLocale(currentLocale, {
            week: {
                dow: weekdays.indexOf(weekStart) || 0,
            },
        });
    }
}

function configureGlobalMomentLocale(localeOverride = "system-default", weekStart = "locale") {
    var _a;
    const obsidianLang = localStorage.getItem("language") || "en";
    const systemLang = (_a = navigator.language) === null || _a === void 0 ? void 0 : _a.toLowerCase();
    let momentLocale = langToMomentLocale[obsidianLang];
    if (localeOverride !== "system-default") {
        momentLocale = localeOverride;
    } else if (systemLang.startsWith(obsidianLang)) {
        momentLocale = systemLang;
    }
    const currentLocale = window.moment.locale(momentLocale);
    console.debug(`[Calendar] Trying to switch Moment.js global locale to ${momentLocale}, got ${currentLocale}`);
    overrideGlobalMomentWeekStart(weekStart);
    return currentLocale;
}

// ============================================
// CALENDAR WRAPPER COMPONENT
// ============================================

function create_fragment_wrapper(ctx) {
    let calendarbase;
    let updating_displayedMonth;
    let current;

    function calendarbase_displayedMonth_binding(value) {
        ctx[12](value);
    }

    let calendarbase_props = {
        sources: ctx[1],
        today: ctx[9],
        onHoverDay: ctx[2],
        onHoverWeek: ctx[3],
        onContextMenuDay: ctx[6],
        onContextMenuWeek: ctx[7],
        onClickDay: ctx[4],
        onClickWeek: ctx[5],
        localeData: ctx[9].localeData(),
        selectedId: ctx[10],
        showWeekNums: ctx[8].showWeeklyNote
    };

    if (ctx[0] !== void 0) {
        calendarbase_props.displayedMonth = ctx[0];
    }

    calendarbase = new Calendar$1({ props: calendarbase_props });
    binding_callbacks$1.push(() => bind(calendarbase, "displayedMonth", calendarbase_displayedMonth_binding));

    return {
        c() { create_component$1(calendarbase.$$.fragment); },
        m(target, anchor) { mount_component$1(calendarbase, target, anchor); current = true; },
        p(ctx, [dirty]) {
            const calendarbase_changes = {};
            if (dirty & 2) calendarbase_changes.sources = ctx[1];
            if (dirty & 512) calendarbase_changes.today = ctx[9];
            if (dirty & 4) calendarbase_changes.onHoverDay = ctx[2];
            if (dirty & 8) calendarbase_changes.onHoverWeek = ctx[3];
            if (dirty & 64) calendarbase_changes.onContextMenuDay = ctx[6];
            if (dirty & 128) calendarbase_changes.onContextMenuWeek = ctx[7];
            if (dirty & 16) calendarbase_changes.onClickDay = ctx[4];
            if (dirty & 32) calendarbase_changes.onClickWeek = ctx[5];
            if (dirty & 512) calendarbase_changes.localeData = ctx[9].localeData();
            if (dirty & 1024) calendarbase_changes.selectedId = ctx[10];
            if (dirty & 256) calendarbase_changes.showWeekNums = ctx[8].showWeeklyNote;

            if (!updating_displayedMonth && dirty & 1) {
                updating_displayedMonth = true;
                calendarbase_changes.displayedMonth = ctx[0];
                add_flush_callback(() => updating_displayedMonth = false);
            }

            calendarbase.$set(calendarbase_changes);
        },
        i(local) { if (current) return; transition_in$1(calendarbase.$$.fragment, local); current = true; },
        o(local) { transition_out$1(calendarbase.$$.fragment, local); current = false; },
        d(detaching) { destroy_component$1(calendarbase, detaching); }
    };
}

function instance_wrapper($$self, $$props, $$invalidate) {
    let $settings;
    let $activeFile;
    component_subscribe($$self, settings, $$value => $$invalidate(8, $settings = $$value));
    component_subscribe($$self, activeFile, $$value => $$invalidate(10, $activeFile = $$value));
    
    let today;
    let { displayedMonth = today } = $$props;
    let { sources } = $$props;
    let { onHoverDay } = $$props;
    let { onHoverWeek } = $$props;
    let { onClickDay } = $$props;
    let { onClickWeek } = $$props;
    let { onContextMenuDay } = $$props;
    let { onContextMenuWeek } = $$props;

    function tick() {
        $$invalidate(9, today = window.moment());
    }

    function getToday(settings) {
        configureGlobalMomentLocale(settings.localeOverride, settings.weekStart);
        return window.moment();
    }

    let heartbeat = setInterval(() => {
        tick();
        const isViewingCurrentMonth = displayedMonth.isSame(today, "day");
        if (isViewingCurrentMonth) {
            $$invalidate(0, displayedMonth = today);
        }
    }, 1000 * 60);

    onDestroy(() => { clearInterval(heartbeat); });

    function calendarbase_displayedMonth_binding(value) {
        displayedMonth = value;
        $$invalidate(0, displayedMonth);
    }

    $$self.$$set = $$props => {
        if ("displayedMonth" in $$props) $$invalidate(0, displayedMonth = $$props.displayedMonth);
        if ("sources" in $$props) $$invalidate(1, sources = $$props.sources);
        if ("onHoverDay" in $$props) $$invalidate(2, onHoverDay = $$props.onHoverDay);
        if ("onHoverWeek" in $$props) $$invalidate(3, onHoverWeek = $$props.onHoverWeek);
        if ("onClickDay" in $$props) $$invalidate(4, onClickDay = $$props.onClickDay);
        if ("onClickWeek" in $$props) $$invalidate(5, onClickWeek = $$props.onClickWeek);
        if ("onContextMenuDay" in $$props) $$invalidate(6, onContextMenuDay = $$props.onContextMenuDay);
        if ("onContextMenuWeek" in $$props) $$invalidate(7, onContextMenuWeek = $$props.onContextMenuWeek);
    };

    $$self.$$.update = () => {
        if ($$self.$$.dirty & 256) {
            $$invalidate(9, today = getToday($settings));
        }
    };

    return [
        displayedMonth, sources, onHoverDay, onHoverWeek, onClickDay, onClickWeek,
        onContextMenuDay, onContextMenuWeek, $settings, today, $activeFile, tick,
        calendarbase_displayedMonth_binding
    ];
}

class Calendar extends SvelteComponent$1 {
    constructor(options) {
        super();
        init$1(this, options, instance_wrapper, create_fragment_wrapper, not_equal$1, {
            displayedMonth: 0, sources: 1, onHoverDay: 2, onHoverWeek: 3,
            onClickDay: 4, onClickWeek: 5, onContextMenuDay: 6, onContextMenuWeek: 7, tick: 11
        });
    }
    get tick() { return this.$$.ctx[11]; }
}

// ============================================
// FULL DAY VIEW + TASK EDITOR
// ============================================
const VIEW_TYPE_PLANNER_DAY = "calendar-planner-day";

function plannerEl(parent, tag, cls, label) {
    const node = document.createElement(tag);
    if (cls) node.className = cls;
    if (label !== undefined) node.textContent = label;
    parent.appendChild(node);
    return node;
}
function plannerIconButton(parent, icon, label, onClick, extra = "") {
    const button = plannerEl(parent, "button", `planner-ui-btn ${extra}`.trim());
    button.type = "button";
    button.setAttribute("aria-label", label);
    button.title = label;
    if (typeof obsidian.setIcon === "function") obsidian.setIcon(button, icon);
    else button.textContent = label;
    button.addEventListener("click", onClick);
    return button;
}
function plannerField(parent, title, type, value, attrs = {}) {
    const row = plannerEl(parent, "label", "planner-field");
    plannerEl(row, "span", "planner-field-label", title);
    const input = plannerEl(row, type === "select" ? "select" : "input", "planner-field-input");
    if (type !== "select") input.type = type;
    if (value !== undefined && value !== null) input.value = value;
    for (const [key, val] of Object.entries(attrs)) input.setAttribute(key, val);
    return input;
}
function plannerWeekdayName(day) { return window.moment(day).format("ddd"); }
function plannerTaskTime(task) {
    return task.startMinutes === null ? "" : `${plannerMinutesToTime(task.startMinutes)}–${plannerMinutesToTime(task.endMinutes)}`;
}

// Drag selection uses 15-minute boundaries. Floor the earlier endpoint and ceil
// the later endpoint, so dragging in either direction yields the same interval.
// The planner's Markdown parser represents the last minute as 23:59 (not 24:00).
function plannerDragTimeRange(anchorMinute, cursorMinute, step = 15) {
    const lower = Math.max(0, Math.min(1439, Math.min(anchorMinute, cursorMinute)));
    const upper = Math.max(0, Math.min(1440, Math.max(anchorMinute, cursorMinute)));
    const start = Math.min(1425, Math.floor(lower / step) * step);
    const end = Math.min(1439, Math.max(start + step, Math.ceil(upper / step) * step));
    return { start, end };
}

class PlannerTaskEditorModal extends obsidian.Modal {
    constructor(plugin, date, task = null, defaults = {}) {
        super(plugin.app);
        this.plugin = plugin;
        this.parser = getPlannerParser(plugin.app);
        this.date = window.moment(date);
        this.task = task;
        this.defaults = defaults;
        this.saving = false;
    }
    onOpen() {
        const { contentEl } = this;
        contentEl.empty();
        contentEl.addClass("planner-editor");
        this.titleEl.setText(this.task ? (this.task.recurrence !== "none" ? "Edit recurring series" : "Edit task") : "New task");
        plannerEl(contentEl, "p", "planner-editor-date", `Date: ${this.date.format("dddd, D MMMM YYYY")}`);
        if (this.task && this.task.recurrence !== "none") {
            plannerEl(contentEl, "p", "planner-editor-hint",
                `Editing the series starting ${window.moment(this.task.sourceDate).format("D MMM YYYY")}. Completion stays separate for each occurrence.`);
        }
        const form = plannerEl(contentEl, "form", "planner-editor-form");
        const title = plannerField(form, "Task", "text", this.task?.text || "", { placeholder: "What are you planning?", required: "" });
        title.maxLength = 500;
        const times = plannerEl(form, "div", "planner-form-pair");
        const start = plannerField(times, "Start time", "time", this.task?.startMinutes !== null && this.task?.startMinutes !== undefined
            ? plannerMinutesToTime(this.task.startMinutes) : this.defaults.startTime || "");
        const end = plannerField(times, "End time", "time", this.task?.endMinutes !== null && this.task?.endMinutes !== undefined
            ? plannerMinutesToTime(this.task.endMinutes) : this.defaults.endTime || "");
        start.addEventListener("change", () => {
            if (start.value && !end.value) {
                const minutes = plannerTimeToMinutes(start.value);
                const next = minutes + (this.plugin.options.defaultTaskMinutes || 60);
                if (next < 1440) end.value = plannerMinutesToTime(next);
            }
        });
        plannerEl(form, "p", "planner-form-help", "Leave both times empty for an unscheduled task.");
        const repeatGroup = plannerEl(form, "div", "planner-form-pair");
        const repeat = plannerField(repeatGroup, "Repeat", "select");
        for (const [val, label] of [["none", "Does not repeat"], ["daily", "Every day"], ["weekdays", "Weekdays (Mon–Fri)"],
            ["weekly", "Every week"], ["monthly", "Every month"], ["yearly", "Every year"]]) {
            const option = plannerEl(repeat, "option", "", label); option.value = val;
        }
        repeat.value = this.task?.recurrence || "none";
        const every = plannerField(repeatGroup, "Every N periods", "number", String(this.task?.every || 1), { min: "1", max: "365", step: "1" });
        const until = plannerField(form, "Repeat until (optional)", "date", this.task?.until || "");
        const rangeToggleRow = plannerEl(form, "label", "planner-checkbox-row");
        const rangeToggle = plannerEl(rangeToggleRow, "input"); rangeToggle.type = "checkbox";
        rangeToggle.checked = !!this.task?.hasRange;
        plannerEl(rangeToggleRow, "span", "", "Multi-day event (date range)");
        const rangeFields = plannerEl(form, "div", "planner-form-pair");
        const fromDate = plannerField(rangeFields, "From", "date", this.task?.fromDate || this.date.format("YYYY-MM-DD"));
        const toDate = plannerField(rangeFields, "To", "date", this.task?.toDate || this.date.clone().add(1, "day").format("YYYY-MM-DD"));
        function updateVisibility() {
            every.closest("label").hidden = repeat.value === "none" || repeat.value === "weekdays";
            until.closest("label").hidden = repeat.value === "none";
            rangeFields.hidden = !rangeToggle.checked;
            rangeToggleRow.hidden = repeat.value !== "none";
            repeatGroup.hidden = rangeToggle.checked;
            if (repeat.value !== "none") rangeToggle.checked = false;
        }
        repeat.addEventListener("change", updateVisibility);
        rangeToggle.addEventListener("change", updateVisibility);
        updateVisibility();
        const buttons = plannerEl(form, "div", "planner-editor-actions");
        const cancel = plannerEl(buttons, "button", "planner-ui-btn", "Cancel"); cancel.type = "button";
        cancel.addEventListener("click", () => this.close());
        if (this.task) {
            const del = plannerEl(buttons, "button", "planner-ui-btn planner-btn-danger", "Delete…"); del.type = "button";
            del.addEventListener("click", () => this.confirmDeletion());
        }
        const submit = plannerEl(buttons, "button", "planner-ui-btn mod-cta", this.task ? "Save changes" : "Create task");
        submit.type = "submit";
        form.addEventListener("submit", async e => {
            e.preventDefault();
            if (this.saving) return;
            try {
                this.saving = true; submit.disabled = true;
                const taskDate = this.task ? window.moment(this.task.sourceDate) : this.date;
                await this.parser.saveTask(taskDate, {
                    text: title.value.trim(), startTime: start.value, endTime: end.value,
                    repeat: repeat.value, every: Number(every.value), until: until.value,
                    multiDay: rangeToggle.checked, fromDate: fromDate.value, toDate: toDate.value
                }, this.task);
                this.plugin.refreshPlannerViews();
                this.close();
            } catch (error) {
                new obsidian.Notice(error.message || "Could not save task.");
                console.error("[Planner] Save failed", error);
            } finally { this.saving = false; submit.disabled = false; }
        });
        setTimeout(() => title.focus(), 0);
    }
    confirmDeletion() {
        const task = this.task;
        const dialog = new obsidian.Modal(this.app);
        dialog.titleEl.setText("Delete task?");
        const body = dialog.contentEl;
        body.empty();
        plannerEl(body, "p", "", `Delete “${task.text}”?`);
        const buttons = plannerEl(body, "div", "planner-editor-actions");
        if (task.recurrence !== "none") {
            const skip = plannerEl(buttons, "button", "planner-ui-btn", "Skip this date");
            skip.addEventListener("click", async () => {
                try {
                    await this.parser.deleteTask(task, this.date, true);
                    dialog.close(); this.close(); this.plugin.refreshPlannerViews();
                } catch (err) { new obsidian.Notice(err.message); }
            });
        }
        const cancel = plannerEl(buttons, "button", "planner-ui-btn", "Cancel");
        cancel.addEventListener("click", () => dialog.close());
        const remove = plannerEl(buttons, "button", "planner-ui-btn planner-btn-danger", task.recurrence !== "none" ? "Delete entire series" : "Delete task");
        remove.addEventListener("click", async () => {
            try {
                await this.parser.deleteTask(task);
                dialog.close(); this.close(); this.plugin.refreshPlannerViews();
            } catch (err) { new obsidian.Notice(err.message); }
        });
        dialog.open();
    }
}

function plannerPartitionOverlaps(tasks) {
    const sorted = [...tasks].sort((a, b) => a.startMinutes - b.startMinutes || a.endMinutes - b.endMinutes);
    const groups = [];
    let current = [], groupEnd = -1;
    for (const task of sorted) {
        if (current.length && task.startMinutes >= groupEnd) {
            groups.push(current); current = []; groupEnd = -1;
        }
        current.push(task);
        groupEnd = Math.max(groupEnd, task.endMinutes);
    }
    if (current.length) groups.push(current);
    const layout = new Map();
    for (const group of groups) {
        const lanes = [];
        for (const task of group) {
            let lane = lanes.findIndex(end => end <= task.startMinutes);
            if (lane < 0) { lane = lanes.length; lanes.push(task.endMinutes); }
            else lanes[lane] = task.endMinutes;
            layout.set(task, { lane, laneCount: 1 });
        }
        for (const task of group) layout.get(task).laneCount = lanes.length;
    }
    return layout;
}

// One view type with three layouts. One week is always Mon–Sun; three days
// begin on the selected date. Navigation moves by the visible interval.
class PlannerDayView extends obsidian.ItemView {
    constructor(leaf, plugin) {
        super(leaf);
        this.plugin = plugin;
        this.parser = getPlannerParser(this.app);
        this.date = window.moment(plugin.selectedPlannerDate || undefined).startOf("day");
        this.spanDays = [1, 3, 7].includes(Number(plugin.options?.plannerViewSpan))
            ? Number(plugin.options.plannerViewSpan) : 1;
        this.hideCompleted = false;
        this.scrollInitialised = false;
        this.minuteTimer = null;
        this.nowLines = [];
        this.activeSelection = null;
        this.registerEvent(this.app.vault.on("modify", file => this.onPlannerFileChange(file)));
        this.registerEvent(this.app.vault.on("create", file => this.onPlannerFileChange(file)));
        this.registerEvent(this.app.vault.on("delete", file => this.onPlannerFileChange(file)));
    }
    getViewType() { return VIEW_TYPE_PLANNER_DAY; }
    getDisplayText() { return "Day Planner"; }
    getIcon() { return "calendar-clock"; }
    async onOpen() {
        await this.parser.parsePlanner();
        this.render();
        this.minuteTimer = window.setInterval(() => this.updateNowLine(), 30000);
    }
    async onClose() {
        this.cancelTimeSelection();
        if (this.minuteTimer) window.clearInterval(this.minuteTimer);
        this.minuteTimer = null;
        this.nowLines = [];
        this.contentEl.empty();
    }
    async onPlannerFileChange(file) {
        if (file.path !== this.parser.plannerPath) return;
        await this.parser.parsePlanner();
        this.render();
    }
    getVisibleDates() {
        const first = this.spanDays === 7 ? this.date.clone().startOf("isoWeek") : this.date.clone();
        return Array.from({ length: this.spanDays }, (_, i) => first.clone().add(i, "day"));
    }
    setDate(date) {
        const next = window.moment(date);
        if (!next.isValid()) return;
        this.date = next.startOf("day");
        this.plugin.selectedPlannerDate = this.date.format("YYYY-MM-DD");
        this.scrollInitialised = false;
        if (this.contentEl.isConnected) this.render();
    }
    setSpan(days) {
        if (![1, 3, 7].includes(days) || this.spanDays === days) return;
        this.spanDays = days;
        this.scrollInitialised = false;
        // Write through plugin settings, retaining mode across app restarts.
        this.plugin.writeOptions(() => ({ plannerViewSpan: days })).catch(error => {
            console.error("[Planner] Could not persist planner view", error);
            new obsidian.Notice("Could not save the planner layout preference.");
        });
        this.render();
    }
    openEditor(task = null, defaults = {}, date = this.date) {
        const modal = new PlannerTaskEditorModal(this.plugin, date, task, defaults);
        modal.open();
    }
    async setComplete(task, date) {
        try {
            await this.parser.toggleTaskCompletion(date, task);
            await this.plugin.refreshPlannerViews();
        } catch (err) { new obsidian.Notice(err.message || "Unable to update task"); }
    }
    getTasks(date) {
        const all = this.parser.getDataForDate(date).tasks;
        return { tasks: all.filter(t => !t.isNote), notes: all.filter(t => t.isNote) };
    }
    getTimelineBounds(days) {
        const opts = this.plugin.options || {};
        const scheduled = days.flatMap(d => this.getTasks(d).tasks)
            .filter(task => task.startMinutes !== null);
        const a = Number(opts.dayStartHour);
        const b = Number(opts.dayEndHour);
        const configuredStart = Number.isFinite(a) && a >= 0 && a < 24 ? a : 6;
        const configuredEnd = Number.isFinite(b) && b > 0 && b <= 24 ? b : 23;
        const earliest = scheduled.length ? Math.min(...scheduled.map(t => t.startMinutes)) : configuredStart * 60;
        const latest = scheduled.length ? Math.max(...scheduled.map(t => t.endMinutes)) : configuredEnd * 60;
        this.startHour = Math.max(0, Math.min(configuredStart, Math.floor(earliest / 60)));
        this.endHour = Math.min(24, Math.max(this.startHour + 1, configuredEnd, Math.ceil(latest / 60)));
        this.hourHeight = Math.min(120, Math.max(44, Number(opts.timelineHourHeight) || 76));
        return (this.endHour - this.startHour) * this.hourHeight;
    }
    addHourLabels(parent) {
        for (let hour = this.startHour; hour <= this.endHour; hour++) {
            const line = plannerEl(parent, "div", "planner-hour-line");
            line.style.top = `${(hour - this.startHour) * this.hourHeight}px`;
            plannerEl(line, "span", "planner-hour-label", `${String(hour).padStart(2,"0")}:00`);
        }
    }
    // A drag begins only on a free time slot, not on a task block. Global
    // pointer listeners keep the selection going across hours and over blocks.
    // Touch retains native vertical scrolling and the existing tap-to-add flow.
    addHourHits(parent, date, multi = false) {
        const preview = plannerEl(parent, "div", `planner-drag-selection${multi ? " planner-drag-selection-multi" : ""}`);
        preview.hidden = true;
        preview.setAttribute("aria-hidden", "true");
        const previewLabel = plannerEl(preview, "span", "planner-drag-selection-label");
        for (let hour = this.startHour; hour < this.endHour; hour++) {
            const line = plannerEl(parent, "div", "planner-slot-line");
            line.style.top = `${(hour - this.startHour) * this.hourHeight}px`;
            if (multi) line.setAttribute("aria-hidden", "true");
            const hit = plannerEl(parent, "button", `planner-hour-hit${multi ? " planner-hour-hit-multi" : ""}`);
            hit.type = "button";
            hit.style.top = `${(hour - this.startHour) * this.hourHeight}px`;
            hit.style.height = `${this.hourHeight}px`;
            hit.setAttribute("aria-label", `Click or drag to add task on ${date.format("dddd D MMMM")} at ${String(hour).padStart(2, "0")}:00`);
            // The browser emits a click after pointerup, including after a drag.
            // Ignore that one synthetic click or a second, wrong-duration dialog opens.
            let suppressClick = false;
            hit.addEventListener("pointerdown", e => {
                if (e.button !== 0 || e.isPrimary === false || e.pointerType === "touch" || this.activeSelection) return;
                this.beginTimeSelection(e, parent, date, preview, previewLabel, () => {
                    suppressClick = true;
                    window.setTimeout(() => { suppressClick = false; }, 0);
                });
            });
            hit.addEventListener("click", e => {
                if (suppressClick) { suppressClick = false; e.preventDefault(); return; }
                const startMin = hour * 60;
                const duration = Number(this.plugin.options?.defaultTaskMinutes) || 60;
                const endMin = Math.min(startMin + duration, 1439);
                this.openEditor(null, { startTime: plannerMinutesToTime(startMin), endTime: plannerMinutesToTime(endMin) }, date);
            });
        }
    }
    timeAtPointer(parent, clientY) {
        const rect = parent.getBoundingClientRect();
        const minutes = this.startHour * 60 + (clientY - rect.top) / this.hourHeight * 60;
        return Math.max(this.startHour * 60, Math.min(this.endHour * 60, minutes));
    }
    beginTimeSelection(event, parent, date, preview, label, suppressClick) {
        const scroll = parent.closest(".planner-day-scroll");
        const selection = {
            pointerId: event.pointerId, parent, date: date.clone(), preview, label, scroll,
            startY: event.clientY, pointerY: event.clientY,
            anchor: this.timeAtPointer(parent, event.clientY),
            moved: false, frame: null, suppressClick, cleanup: []
        };
        this.activeSelection = selection;
        const move = e => {
            if (e.pointerId !== selection.pointerId || this.activeSelection !== selection) return;
            selection.pointerY = e.clientY;
            if (!selection.moved && Math.abs(e.clientY - selection.startY) >= 6) {
                selection.moved = true;
                this.contentEl.addClass("planner-is-selecting");
            }
            if (selection.moved) {
                e.preventDefault();
                this.updateTimeSelection(selection);
                this.startSelectionAutoScroll(selection);
            }
        };
        const end = e => {
            if (e.pointerId !== selection.pointerId || this.activeSelection !== selection) return;
            // A pointerup can be the first event after a fast drag.
            selection.pointerY = e.clientY;
            if (!selection.moved && Math.abs(e.clientY - selection.startY) >= 6) selection.moved = true;
            if (selection.moved) {
                const range = plannerDragTimeRange(selection.anchor, this.timeAtPointer(parent, e.clientY));
                const defaults = { startTime: plannerMinutesToTime(range.start), endTime: plannerMinutesToTime(range.end) };
                selection.suppressClick();
                this.cancelTimeSelection();
                this.openEditor(null, defaults, selection.date);
            } else this.cancelTimeSelection(); // Allow the normal click-to-add.
        };
        const cancel = e => {
            if (e && e.pointerId !== undefined && e.pointerId !== selection.pointerId) return;
            this.cancelTimeSelection();
        };
        const onKey = e => { if (e.key === "Escape") cancel(); };
        for (const [name, handler] of [["pointermove", move], ["pointerup", end], ["pointercancel", cancel], ["blur", cancel], ["keydown", onKey]]) {
            window.addEventListener(name, handler);
            selection.cleanup.push(() => window.removeEventListener(name, handler));
        }
    }
    updateTimeSelection(selection) {
        if (this.activeSelection !== selection) return;
        const range = plannerDragTimeRange(selection.anchor, this.timeAtPointer(selection.parent, selection.pointerY));
        selection.preview.hidden = false;
        selection.preview.style.top = `${(range.start / 60 - this.startHour) * this.hourHeight}px`;
        selection.preview.style.height = `${(range.end - range.start) / 60 * this.hourHeight}px`;
        selection.label.textContent = `${plannerMinutesToTime(range.start)} – ${plannerMinutesToTime(range.end)}`;
    }
    startSelectionAutoScroll(selection) {
        if (selection.frame !== null || !selection.scroll || typeof window.requestAnimationFrame !== "function") return;
        const tick = () => {
            selection.frame = null;
            if (this.activeSelection !== selection || !selection.moved) return;
            const bounds = selection.scroll.getBoundingClientRect();
            const edge = 46;
            const y = selection.pointerY;
            let velocity = 0;
            if (y >= bounds.bottom - edge && y <= bounds.bottom + 25) velocity = Math.min(20, 3 + (edge - (bounds.bottom - y)) / 2);
            else if (y <= bounds.top + edge && y >= bounds.top - 25) velocity = -Math.min(20, 3 + (edge - (y - bounds.top)) / 2);
            if (!velocity) return;
            const before = selection.scroll.scrollTop;
            selection.scroll.scrollTop += velocity;
            if (selection.scroll.scrollTop === before) return; // Reached top or bottom.
            this.updateTimeSelection(selection);
            selection.frame = window.requestAnimationFrame(tick);
        };
        selection.frame = window.requestAnimationFrame(tick);
    }
    cancelTimeSelection() {
        const selection = this.activeSelection;
        if (!selection) return;
        this.activeSelection = null;
        for (const cleanup of selection.cleanup) cleanup();
        if (selection.frame !== null && typeof window.cancelAnimationFrame === "function") window.cancelAnimationFrame(selection.frame);
        selection.preview.hidden = true;
        this.contentEl.toggleClass("planner-is-selecting", false);
    }
    addTimeBlocks(parent, tasks, date, isMulti = false) {
        const layer = plannerEl(parent, "div", `planner-blocks-layer${isMulti ? " planner-blocks-multi" : ""}`);
        const scheduled = tasks.filter(t => t.startMinutes !== null && (!this.hideCompleted || !t.completed));
        const positions = plannerPartitionOverlaps(scheduled);
        for (const task of scheduled) {
            const position = positions.get(task);
            const clampedStart = Math.max(this.startHour * 60, task.startMinutes);
            const clampedEnd = Math.min(this.endHour * 60, task.endMinutes);
            const block = plannerEl(layer, "div", `planner-time-block${task.completed ? " is-done" : ""}${task.recurrence !== "none" ? " is-recurring" : ""}`);
            block.style.top = `${(clampedStart / 60 - this.startHour) * this.hourHeight + 2}px`;
            block.style.height = `${Math.max(18, (clampedEnd - clampedStart) / 60 * this.hourHeight - 3)}px`;
            block.style.left = `${position.lane / position.laneCount * 100}%`;
            block.style.width = `${100 / position.laneCount}%`;
            block.title = `${date.format("ddd D MMM")}: ${plannerTaskTime(task)} ${task.text}${task.recurrence !== "none" ? ` (repeats ${task.recurrence})` : ""}`;
            const check = plannerEl(block, "input", "planner-block-checkbox");
            check.type = "checkbox"; check.checked = !!task.completed;
            check.setAttribute("aria-label", `Complete ${task.text} on ${date.format("D MMMM")}`);
            check.addEventListener("click", event => event.stopPropagation());
            check.addEventListener("change", () => this.setComplete(task, date));
            const edit = plannerEl(block, "button", "planner-block-main");
            edit.type = "button";
            plannerEl(edit, "strong", "planner-block-title", task.text);
            plannerEl(edit, "span", "planner-block-time", plannerTaskTime(task));
            edit.addEventListener("click", () => this.openEditor(task, {}, date));
            if (task.recurrence !== "none") plannerEl(block, "span", "planner-block-repeating", "↻");
        }
    }
    addUnscheduled(parent, tasks, date, compact = false) {
        const filtered = tasks.filter(t => t.startMinutes === null && (!this.hideCompleted || !t.completed));
        const list = plannerEl(parent, "div", `planner-side-task-list${compact ? " planner-compact-list" : ""}`);
        for (const task of filtered) {
            const row = plannerEl(list, "div", `planner-side-task${task.completed ? " is-done" : ""}`);
            const check = plannerEl(row, "input"); check.type = "checkbox"; check.checked = !!task.completed;
            check.setAttribute("aria-label", `Complete ${task.text} on ${date.format("D MMMM")}`);
            check.addEventListener("change", () => this.setComplete(task, date));
            const edit = plannerEl(row, "button", "planner-side-task-title", task.text); edit.type = "button";
            edit.title = task.text;
            edit.addEventListener("click", () => this.openEditor(task, {}, date));
            if (task.recurrence !== "none") plannerEl(row, "span", "planner-repeat-pill", "↻");
            if (task.hasRange) plannerEl(row, "span", "planner-range-pill", "Multi-day");
        }
        return filtered.length;
    }
    addNowLine(grid, date, multi = false) {
        const el = plannerEl(grid, "div", `planner-now-line${multi ? " planner-now-line-multi" : ""}`);
        this.nowLines.push({ el, date: date.clone() });
    }
    renderSingle(root, date) {
        const {tasks, notes} = this.getTasks(date);
        const content = plannerEl(root, "div", "planner-day-content");
        const panel = plannerEl(content, "section", "planner-day-timeline-panel");
        const panelHeader = plannerEl(panel, "div", "planner-panel-header");
        plannerEl(panelHeader, "h3", "", "Timeline");
        plannerEl(panelHeader, "span", "planner-muted", "Click to add · drag to select a time range");
        const scroll = plannerEl(panel, "div", "planner-day-scroll");
        const height = this.getTimelineBounds([date]);
        const grid = plannerEl(scroll, "div", "planner-time-grid");
        grid.style.height = `${height}px`;
        this.addHourLabels(grid);
        this.addHourHits(grid, date);
        this.addTimeBlocks(grid, tasks, date);
        this.addNowLine(grid, date);
        const side = plannerEl(content, "aside", "planner-day-sidebar");
        const sideHeader = plannerEl(side, "div", "planner-panel-header");
        plannerEl(sideHeader, "h3", "", "Unscheduled & all-day");
        const count = this.addUnscheduled(side, tasks, date);
        if (!count && !notes.length) plannerEl(side, "p", "planner-empty-state", "No unscheduled tasks for this date.");
        if (notes.length) {
            plannerEl(side, "h4", "planner-notes-heading", "Notes");
            for (const note of notes) plannerEl(side, "p", "planner-note-entry", note.text);
        }
        const add = plannerEl(side, "button", "planner-ui-btn planner-side-add", "+ Add unscheduled task");
        add.type = "button"; add.addEventListener("click", () => this.openEditor(null, {}, date));
        return scroll;
    }
    renderMulti(root, dates) {
        const content = plannerEl(root, "div", "planner-day-content planner-multi-content");
        const panel = plannerEl(content, "section", "planner-day-timeline-panel planner-multi-panel");
        const panelHeader = plannerEl(panel, "div", "planner-panel-header");
        plannerEl(panelHeader, "h3", "", this.spanDays === 7 ? "Week timeline" : "3-day timeline");
        plannerEl(panelHeader, "span", "planner-muted", "Click to add · drag to select start/end times · + adds all-day");
        const scroll = plannerEl(panel, "div", "planner-day-scroll planner-multi-scroll");
        const board = plannerEl(scroll, "div", `planner-multi-board planner-span-${this.spanDays}`);
        board.style.setProperty("--planner-days", String(this.spanDays));
        const head = plannerEl(board, "div", "planner-multi-header");
        const corner = plannerEl(head, "div", "planner-multi-corner", "ALL DAY");
        corner.title = "All-day and unscheduled tasks";
        for (const date of dates) {
            const { tasks, notes } = this.getTasks(date);
            const cell = plannerEl(head, "div", `planner-multi-day-header${date.isSame(window.moment(), "day") ? " is-today" : ""}`);
            const top = plannerEl(cell, "div", "planner-multi-day-heading");
            const openDay = plannerEl(top, "button", "planner-multi-day-name"); openDay.type = "button";
            const label = this.spanDays === 7 ? date.format("ddd D") : date.format("ddd D MMM");
            openDay.textContent = label;
            openDay.title = `Open ${date.format("dddd D MMMM YYYY")} in day view`;
            openDay.addEventListener("click", () => { this.setDate(date); this.setSpan(1); });
            plannerIconButton(top, "plus", `Add task on ${date.format("D MMMM")}`, () => this.openEditor(null, {}, date), "planner-small-add");
            const allDay = plannerEl(cell, "div", "planner-multi-all-day");
            const num = this.addUnscheduled(allDay, tasks, date, true);
            if (notes.length) {
                for (const note of notes) {
                    const el = plannerEl(allDay, "p", "planner-multi-note", note.text);
                    el.title = note.text;
                }
            }
            if (!num && !notes.length) plannerEl(allDay, "span", "planner-multi-no-tasks", "No all-day tasks");
        }
        const height = this.getTimelineBounds(dates);
        const grid = plannerEl(board, "div", "planner-multi-grid");
        grid.style.height = `${height}px`;
        const timeAxis = plannerEl(grid, "div", "planner-multi-time-axis");
        this.addHourLabels(timeAxis);
        for (const date of dates) {
            const {tasks} = this.getTasks(date);
            const column = plannerEl(grid, "div", `planner-multi-column${date.isSame(window.moment(), "day") ? " is-today" : ""}`);
            column.setAttribute("aria-label", date.format("dddd D MMMM YYYY"));
            this.addHourHits(column, date, true);
            this.addTimeBlocks(column, tasks, date, true);
            this.addNowLine(column, date, true);
        }
        return scroll;
    }
    render() {
        const root = this.contentEl;
        if (!root) return;
        this.cancelTimeSelection();
        const prevScroll = root.querySelector(".planner-day-scroll")?.scrollTop;
        const prevHorizontal = root.querySelector(".planner-day-scroll")?.scrollLeft;
        root.empty();
        root.addClass("planner-day-root");
        root.toggleClass("planner-in-multi", this.spanDays > 1);
        const days = this.getVisibleDates();
        const allTasks = days.flatMap(date => this.getTasks(date).tasks);
        const completed = allTasks.filter(t => t.completed).length;
        const toolbar = plannerEl(root, "header", "planner-day-toolbar");
        const heading = plannerEl(toolbar, "div", "planner-heading");
        plannerEl(heading, "div", "planner-eyebrow", "DAY PLANNER");
        const mainTitle = this.spanDays === 7
            ? `${days[0].format("D MMM")} – ${days[6].format("D MMM YYYY")}`
            : this.spanDays === 3
                ? `${days[0].format("D MMM")} – ${days[2].format("D MMM YYYY")}`
                : this.date.format("dddd, D MMMM YYYY");
        plannerEl(heading, "h2", "planner-day-title", mainTitle);
        const nav = plannerEl(toolbar, "div", "planner-day-nav");
        plannerIconButton(nav, "chevron-left", this.spanDays === 7 ? "Previous week" : "Previous period", () => this.setDate(this.date.clone().subtract(this.spanDays, "days")));
        const picker = plannerEl(nav, "input", "planner-date-picker");
        picker.type = "date"; picker.value = this.date.format("YYYY-MM-DD");
        picker.setAttribute("aria-label", "Choose starting date");
        picker.addEventListener("change", () => { if (picker.value) this.setDate(window.moment(picker.value, "YYYY-MM-DD", true)); });
        const today = plannerEl(nav, "button", "planner-ui-btn", "Today"); today.type = "button";
        today.addEventListener("click", () => this.setDate(window.moment()));
        plannerIconButton(nav, "chevron-right", this.spanDays === 7 ? "Next week" : "Next period", () => this.setDate(this.date.clone().add(this.spanDays, "days")));
        const actions = plannerEl(root, "div", "planner-day-actions");
        const progress = plannerEl(actions, "div", "planner-progress");
        plannerEl(progress, "span", "planner-progress-label", `${completed} of ${allTasks.length} tasks completed${this.spanDays > 1 ? ` across ${this.spanDays} days` : ""}`);
        const track = plannerEl(progress, "div", "planner-progress-track");
        const bar = plannerEl(track, "div", "planner-progress-bar");
        bar.style.width = `${allTasks.length ? Math.round(100 * completed / allTasks.length) : 0}%`;
        const buttons = plannerEl(actions, "div", "planner-actions-buttons");
        const modes = plannerEl(buttons, "div", "planner-view-modes");
        modes.setAttribute("role", "group"); modes.setAttribute("aria-label", "Timeline layout");
        for (const [span, name] of [[1, "Day"], [3, "3 days"], [7, "Week"]]) {
            const button = plannerEl(modes, "button", `planner-mode-btn${this.spanDays === span ? " is-active" : ""}`, name);
            button.type = "button"; button.setAttribute("aria-pressed", String(this.spanDays === span));
            button.addEventListener("click", () => this.setSpan(span));
        }
        const hide = plannerEl(buttons, "button", `planner-ui-btn ${this.hideCompleted ? "is-active" : ""}`, this.hideCompleted ? "Show completed" : "Hide completed");
        hide.type = "button"; hide.setAttribute("aria-pressed", String(this.hideCompleted));
        hide.addEventListener("click", () => { this.hideCompleted = !this.hideCompleted; this.render(); });
        plannerIconButton(buttons, "file-text", "Open planner Markdown", () => this.plugin.openPlannerFile());
        const add = plannerEl(buttons, "button", "planner-ui-btn mod-cta", "+ New task"); add.type = "button";
        add.title = this.spanDays === 7 ? "Add a task on the selected date (use each column's + to choose a day)" : "Add a task on the selected date";
        add.addEventListener("click", () => this.openEditor(null, {}, this.date));
        this.nowLines = [];
        const scroll = this.spanDays === 1 ? this.renderSingle(root, days[0]) : this.renderMulti(root, days);
        this.updateNowLine();
        if (this.scrollInitialised && prevScroll != null) {
            scroll.scrollTop = prevScroll;
            if (prevHorizontal != null) scroll.scrollLeft = prevHorizontal;
        } else {
            const current = window.moment();
            const reference = days.some(d => d.isSame(current, "day")) ? current.hours() * 60 + current.minutes() : 9 * 60;
            scroll.scrollTop = Math.max(0, (reference / 60 - this.startHour) * this.hourHeight - 150);
        }
        this.scrollInitialised = true;
    }
    updateNowLine() {
        const current = window.moment();
        const minute = current.hours() * 60 + current.minutes() + current.seconds() / 60;
        for (const {el, date} of this.nowLines) {
            const visible = date.isSame(current, "day") && minute >= this.startHour * 60 && minute <= this.endHour * 60;
            el.style.display = visible ? "block" : "none";
            if (visible) el.style.top = `${(minute / 60 - this.startHour) * this.hourHeight}px`;
        }
    }
}


// ============================================
// CALENDAR VIEW
// ============================================

class CalendarView extends obsidian.ItemView {
    constructor(leaf, plugin) {
        super(leaf);
        this.plugin = plugin;
        this.parser = getPlannerParser(this.app);
        this.activeModal = null;
        
        this.openPlannerDay = this.openPlannerDay.bind(this);
        this.onFileModified = this.onFileModified.bind(this);
        this.onFileCreated = this.onFileCreated.bind(this);
        this.onFileDeleted = this.onFileDeleted.bind(this);
        this.onHoverDay = this.onHoverDay.bind(this);
        this.onContextMenuDay = this.onContextMenuDay.bind(this);

        this.registerEvent(this.app.vault.on("modify", this.onFileModified));
        this.registerEvent(this.app.vault.on("create", this.onFileCreated));
        this.registerEvent(this.app.vault.on("delete", this.onFileDeleted));

        this.settings = null;
        settings.subscribe((val) => {
            this.settings = val;
            if (this.parser) {
                this.parser.setPlannerPath(val.plannerPath || DEFAULT_PLANNER_PATH);
            }
            if (this.calendar) {
                this.refreshCalendar();
            }
        });
    }

    getViewType() {
        return VIEW_TYPE_CALENDAR;
    }

    getDisplayText() {
        return "Calendar Planner";
    }

    getIcon() {
        return "calendar-with-checkmark";
    }

    onClose() {
        if (this.calendar) {
            this.calendar.$destroy();
        }
        return Promise.resolve();
    }

    async onOpen() {
        await this.parser.parsePlanner();

        const sources = [
            createPlannerStreakSource(this.parser),
            createPlannerTaskSource(this.parser, settings),
        ];

        this.app.workspace.trigger(TRIGGER_ON_OPEN, sources);

        this.calendar = new Calendar({
            target: this.contentEl,
            props: {
                onClickDay: this.openPlannerDay,
                onClickWeek: () => {},
                onHoverDay: this.onHoverDay,
                onHoverWeek: () => {},
                onContextMenuDay: this.onContextMenuDay,
                onContextMenuWeek: () => {},
                sources,
            },
        });
    }

    onHoverDay(date, targetEl, isMetaPressed) {
        if (!isMetaPressed) return;
        
        const data = this.parser.getDataForDate(date);
        if (data && data.tasks && data.tasks.length > 0) {
            const taskSummary = data.tasks
                .filter(t => !t.isNote)
                .map(t => `${t.completed ? '✓' : '○'} ${t.text}`)
                .join('\n');
            
            this.app.workspace.trigger("link-hover", this, targetEl, taskSummary, this.parser.plannerPath);
        }
    }

    onContextMenuDay(date, event) {
        const menu = new obsidian.Menu(this.app);
        const data = this.parser.getDataForDate(date);
        const { moment } = window;
        const dateStr = moment(date).format("DD/MM/YYYY");

        menu.addItem((item) =>
            item
                .setTitle("Open Day View")
                .setIcon("calendar")
                .onClick(() => this.openPlannerDay(date, false))
        );

        menu.addItem((item) =>
            item.setTitle("Quick edit (popup)").setIcon("square-pen")
                .onClick(() => this.openQuickDayModal(date))
        );

        menu.addItem((item) =>
            item
                .setTitle("Add Entry")
                .setIcon("plus")
                .onClick(async () => {
                    const text = await this.promptForEntry();
                    if (text) {
                        await this.parser.addEntryForDate(date, text);
                        this.refreshCalendar();
                    }
                })
        );

        if (data && data.tasks && data.tasks.length > 0) {
            menu.addSeparator();
            menu.addItem((item) =>
                item
                    .setTitle("Open in Planner")
                    .setIcon("file-text")
                    .onClick(async () => {
                        const plannerFile = this.app.vault.getAbstractFileByPath(this.parser.plannerPath);
                        if (plannerFile && plannerFile instanceof obsidian__default['default'].TFile) {
                            const leaf = this.app.workspace.getUnpinnedLeaf();
                            await leaf.openFile(plannerFile);
                            
                            if (data.lineStart !== undefined) {
                                const view = leaf.view;
                                if (view.editor) {
                                    view.editor.setCursor({ line: data.lineStart, ch: 0 });
                                    view.editor.scrollIntoView({ 
                                        from: { line: data.lineStart, ch: 0 }, 
                                        to: { line: data.lineStart, ch: 0 } 
                                    }, true);
                                }
                            }
                        }
                    })
            );
        }

        menu.showAtPosition({ x: event.pageX, y: event.pageY });
    }

    async promptForEntry() {
        return new Promise((resolve) => {
            const modal = new obsidian.Modal(this.app);
            modal.titleEl.setText("Add Entry");
            modal.contentEl.addClass('planner-prompt-modal');
            
            const container = modal.contentEl.createDiv({ cls: 'planner-prompt-container' });
            
            const input = container.createEl("input", {
                type: "text",
                placeholder: "Enter task or note...",
                cls: "planner-prompt-input"
            });
            
            const submitBtn = container.createEl("button", { 
                text: "Add",
                cls: "planner-prompt-button" 
            });
            
            // Apply styles
            container.style.cssText = 'display: flex; flex-direction: column; gap: 12px;';
            input.style.cssText = 'width: 100%; padding: 10px 12px; border: 1px solid var(--background-modifier-border); border-radius: 6px; background: var(--background-primary); color: var(--text-normal); font-size: 14px;';
            submitBtn.style.cssText = 'padding: 10px 20px; border: none; border-radius: 6px; background: var(--interactive-accent); color: var(--text-on-accent); cursor: pointer; font-size: 14px; font-weight: 500;';
            
            submitBtn.onclick = () => {
                resolve(input.value.trim());
                modal.close();
            };
            
            input.onkeypress = (e) => {
                if (e.key === "Enter") {
                    resolve(input.value.trim());
                    modal.close();
                }
            };
            
            modal.onClose = () => {
                if (!input.value) resolve(null);
            };
            
            modal.open();
            input.focus();
        });
    }

    async openPlannerDay(date, inNewSplit) {
        return this.plugin.openDayView(date);
    }

    openQuickDayModal(date) {
        if (this.activeModal) this.activeModal.close();
        const modal = new PlannerDayModal(
            this.app, 
            date, 
            this.parser, 
            () => this.refreshCalendar()
        );
        this.activeModal = modal;
        modal.open();
        activeFile.setDate(date);
    }

    async onFileModified(file) {
        if (file.path === this.parser.plannerPath) {
            await this.parser.parsePlanner();
            this.refreshCalendar();
        }
    }

    async onFileCreated(file) {
        if (file.path === this.parser.plannerPath) {
            await this.parser.parsePlanner();
            this.refreshCalendar();
        }
    }

    async onFileDeleted(file) {
        if (file.path === this.parser.plannerPath) {
            await this.parser.parsePlanner();
            this.refreshCalendar();
        }
    }

    async refreshCalendar() {
        await this.parser.parsePlanner();
        if (this.calendar) {
            this.calendar.tick();
        }
    }
}

// ============================================
// MAIN PLUGIN
// ============================================

class CalendarPlugin extends obsidian.Plugin {
    onunload() {
        this.app.workspace
            .getLeavesOfType(VIEW_TYPE_CALENDAR)
            .forEach((leaf) => leaf.detach());
        this.app.workspace.getLeavesOfType(VIEW_TYPE_PLANNER_DAY).forEach(leaf => leaf.detach());
    }

    async onload() {
        this.register(settings.subscribe((value) => {
            this.options = value;
        }));

        this.registerView(VIEW_TYPE_CALENDAR, (leaf) => (this.view = new CalendarView(leaf, this)));
        this.registerView(VIEW_TYPE_PLANNER_DAY, (leaf) => new PlannerDayView(leaf, this));
        this.addRibbonIcon("calendar-clock", "Open day planner", () => this.openDayView());
        this.addCommand({ id: "show-day-planner", name: "Open Day View", callback: () => this.openDayView() });
        this.addCommand({ id: "show-today-planner", name: "Open today's Day View", callback: () => this.openDayView(window.moment()) });
        this.addCommand({ id: "add-timed-planner-task", name: "Add timed planner task", callback: () => {
            const modal = new PlannerTaskEditorModal(this, window.moment()); modal.open();
        } });

        this.addCommand({
            id: "show-calendar-view",
            name: "Open calendar planner",
            checkCallback: (checking) => {
                if (checking) {
                    return (this.app.workspace.getLeavesOfType(VIEW_TYPE_CALENDAR).length === 0);
                }
                this.initLeaf();
            },
        });

        this.addCommand({
            id: "open-planner-file",
            name: "Open planner file",
            callback: async () => {
                const parser = getPlannerParser(this.app);
                const plannerFile = this.app.vault.getAbstractFileByPath(parser.plannerPath);
                if (plannerFile && plannerFile instanceof obsidian__default['default'].TFile) {
                    const leaf = this.app.workspace.getUnpinnedLeaf();
                    await leaf.openFile(plannerFile);
                } else {
                    new obsidian__default['default'].Notice(`Planner file not found: ${parser.plannerPath}`);
                }
            },
        });

        this.addCommand({
            id: "add-entry-today",
            name: "Add entry for today",
            callback: async () => {
                const parser = getPlannerParser(this.app);
                const text = await this.promptForEntry();
                if (text) {
                    await parser.addEntryForDate(window.moment(), text);
                    if (this.view) {
                        await this.view.refreshCalendar();
                    }
                }
            },
        });

        await this.loadOptions();
        const parser = getPlannerParser(this.app);
        parser.setPlannerPath(this.options.plannerPath || DEFAULT_PLANNER_PATH);
        await parser.parsePlanner();
        this.addSettingTab(new CalendarSettingsTab(this.app, this));

        if (this.app.workspace.layoutReady) {
            this.initLeaf();
        } else {
            this.registerEvent(this.app.workspace.on("layout-ready", this.initLeaf.bind(this)));
        }
    }

    async openDayView(date = null) {
        const target = window.moment(date || this.selectedPlannerDate || undefined);
        this.selectedPlannerDate = target.format("YYYY-MM-DD");
        let leaf = this.app.workspace.getLeavesOfType(VIEW_TYPE_PLANNER_DAY)[0];
        if (!leaf) {
            leaf = this.app.workspace.getLeaf("tab");
            await leaf.setViewState({ type: VIEW_TYPE_PLANNER_DAY, active: true });
        }
        if (leaf.view instanceof PlannerDayView) leaf.view.setDate(target);
        await this.app.workspace.revealLeaf(leaf);
    }

    async openPlannerFile() {
        const parser = getPlannerParser(this.app);
        const file = this.app.vault.getAbstractFileByPath(parser.plannerPath);
        if (file instanceof obsidian.TFile) {
            await this.app.workspace.getLeaf("tab").openFile(file);
        } else new obsidian.Notice(`Planner file not found: ${parser.plannerPath}`);
    }

    async refreshPlannerViews() {
        const parser = getPlannerParser(this.app);
        await parser.parsePlanner();
        for (const leaf of this.app.workspace.getLeavesOfType(VIEW_TYPE_PLANNER_DAY)) {
            if (leaf.view instanceof PlannerDayView) leaf.view.render();
        }
        for (const leaf of this.app.workspace.getLeavesOfType(VIEW_TYPE_CALENDAR)) {
            if (leaf.view.calendar) leaf.view.calendar.tick();
        }
    }

    async promptForEntry() {
        return new Promise((resolve) => {
            const modal = new obsidian.Modal(this.app);
            modal.titleEl.setText("Add Entry for Today");
            modal.contentEl.addClass('planner-prompt-modal');
            
            const container = modal.contentEl.createDiv({ cls: 'planner-prompt-container' });
            
            const input = container.createEl("input", {
                type: "text",
                placeholder: "Enter task or note...",
                cls: "planner-prompt-input"
            });
            
            const submitBtn = container.createEl("button", { 
                text: "Add",
                cls: "planner-prompt-button" 
            });
            
            // Apply styles
            container.style.cssText = 'display: flex; flex-direction: column; gap: 12px;';
            input.style.cssText = 'width: 100%; padding: 10px 12px; border: 1px solid var(--background-modifier-border); border-radius: 6px; background: var(--background-primary); color: var(--text-normal); font-size: 14px;';
            submitBtn.style.cssText = 'padding: 10px 20px; border: none; border-radius: 6px; background: var(--interactive-accent); color: var(--text-on-accent); cursor: pointer; font-size: 14px; font-weight: 500;';
            
            submitBtn.onclick = () => {
                resolve(input.value.trim());
                modal.close();
            };
            
            input.onkeypress = (e) => {
                if (e.key === "Enter") {
                    resolve(input.value.trim());
                    modal.close();
                }
            };
            
            modal.onClose = () => {
                if (!input.value) resolve(null);
            };
            
            modal.open();
            input.focus();
        });
    }

    initLeaf() {
        if (this.app.workspace.getLeavesOfType(VIEW_TYPE_CALENDAR).length) {
            return;
        }
        this.app.workspace.getRightLeaf(false).setViewState({
            type: VIEW_TYPE_CALENDAR,
        });
    }

    async loadOptions() {
        const options = await this.loadData();
        settings.update((old) => {
            return Object.assign(Object.assign({}, old), (options || {}));
        });
        await this.saveData(this.options);
    }

    async writeOptions(changeOpts) {
        settings.update((old) => (Object.assign(Object.assign({}, old), changeOpts(old))));
        getPlannerParser(this.app).setPlannerPath(this.options.plannerPath || DEFAULT_PLANNER_PATH);
        await this.saveData(this.options);
        await this.refreshPlannerViews();
    }
}

module.exports = CalendarPlugin;

/* nosourcemap */