import { and, asc, desc, eq, inArray, isNotNull, isNull, lt, or, type SQL } from "drizzle-orm";
import { NotPermitted, organizationPolicy, visibleCases } from "../access/policy";
import { lockCase } from "../cases/cases";
import type { Clock } from "../clock";
import type { Db } from "../db/client";
import { actionLog, cases, integrations, observables, responseActions, user } from "../db/schema";
import { providerLabel } from "../integrations/vocabulary";
import type { Membership } from "../members/membership";
import { extractObservables } from "../observables/extract";
import { InvalidValue, linkObservable, type ObservableStore } from "../observables/observables";
import { normaliseObservable, type ObservableType, observableTypeLabel } from "../observables/vocabulary";
import { publish } from "../realtime/signals";
import type { ResponseActionStore, Skipped } from "../response-actions/response-actions";
import {
  FALCON_IOC_PLATFORMS,
  falconIocPlatformLabel,
  type ResponseActionKind,
  type ResponseActionOrigin,
  type ResponseActionState,
} from "../response-actions/vocabulary";
import { severityLabel } from "../cases/vocabulary";
import type { IpLookupStore } from "../ipinfo/ip-lookups";
import type { HashLookupStore } from "../virustotal/hash-lookups";
import type { DomainUrlLookupStore } from "../virustotal/domain-url-lookups";
import type { UmbrellaDomainCheckStore } from "../umbrella/domain-checks";
import { logRun } from "./action-log";
import {
  type CenterAction,
  centerActionAccepts,
  centerActionGroup,
  centerActionLabel,
  type CenterGroup,
  type CenterLookup,
  type CenterResponseAction,
  isCenterLookup,
  isCenterResponseAction,
  type LogAction,
  logActionGroup,
  logActionLabel,
  type LogOutcome,
  type LogSource,
} from "./vocabulary";

/**
 * The Action Center (ADR 0016): every action Argus can take on an Observable, for the Organization's
 * Members to run on any values, with or without a Case, and the Action Log of every run. Members only.
 *
 * Response Actions go through the Response Actions module (`takeValues`), which logs each one as it is
 * taken. Marks go through the Observables module, which logs every mark wherever it is made. Lookups
 * are logged here, since only those run from the Action Center are (lookups on opening a panel are
 * not). Containment is run on a Case, through its own confirmation, and isn't run here.
 */

/** Whether an action can run now, and if not, why. */
export type CardStatus = "ready" | "off" | "paused" | "no_list" | "unconfigured" | "no_key" | "admin_only";

/** One action through one Integration (or none, for those Argus runs itself), as the catalogue offers it. */
export type CatalogueCard = {
  action: CenterAction;
  group: CenterGroup;
  label: string;
  /** The Integration it goes through; null for marks and VirusTotal, or when the Organization has none. */
  integration: { id: string; name: string } | null;
  /** What runs it, such as "CrowdStrike · Falcon US-1" or "VirusTotal · your key". */
  through: string;
  accepts: readonly (ObservableType | "host")[];
  status: CardStatus;
  /** Why it can't run, or what it runs with, for the card and its dialog. */
  statusText: string;
  adminOnly: boolean;
  /** What it is sent with, as the dialog shows it: severity, platforms, a destination list. */
  settings: { label: string; value: string }[];
};

/** The values a run pulled out of what was pasted, and those it left out with why. */
export type RunInput = {
  action: Exclude<CenterAction, "contain" | "lift_containment">;
  /** One value per line, or any text: Observables are pulled out of it as Bulk Lookup does. */
  text: string;
  /** For a Response Action: the Integrations to take it through, every one of the action's Provider. */
  integrationIds?: string[];
  /** The Case to link each value to and take the action from; null or left out for none. */
  caseNumber?: number | null;
  /** Why, for a Response Action without a Case: sent to the tool in place of the Case's reference. */
  reason?: string | null;
  /** Hidden from the Case's Guests; only with a Case. */
  internal?: boolean;
  /** Sends Observables on the Ignored list too. */
  confirmIgnored?: boolean;
};

/** What happened to one value of a run. */
export type RunValue = {
  type: ObservableType | null;
  value: string;
  outcome: "taken" | "done" | "cached" | "unchanged" | "failed" | "skipped";
  /** Why it was skipped or failed, or what a lookup said. */
  detail: string | null;
};

export type RunResult = { values: RunValue[]; responseActionIds: string[]; case: { number: number; title: string } | null };

/** One row of the Action Log, as a Member reads it. */
export type LogEntry = {
  id: string;
  at: string;
  action: LogAction;
  group: CenterGroup;
  /** What ran: "IOC alert", "Block domain", "IP details". */
  label: string;
  value: { type: string; value: string };
  observableId: string | null;
  assetId: string | null;
  integration: { id: string; name: string } | null;
  case: { number: number; title: string } | null;
  by: { id: string; name: string };
  source: LogSource;
  /** A Response Action's current state, or how a mark or lookup went. */
  state: ResponseActionState | LogOutcome;
  /** Why it failed, or the reason given for a Response Action without a Case. */
  detail: string | null;
  /** For a Response Action: what can be done to it from the Action Log, which is only while it has no Case. */
  responseAction: {
    id: string;
    kind: ResponseActionKind;
    origin: ResponseActionOrigin;
    reason: string | null;
    error: string | null;
    retryable: boolean;
    removable: boolean;
    dismissable: boolean;
  } | null;
};

export type LogFilter = {
  /** Linked to a Case, or not. */
  link?: "linked" | "unlinked";
  group?: CenterGroup;
  /** Only rows taken by this Member. */
  byId?: string;
  /** Rows before this one, for the next page. */
  before?: string;
  limit?: number;
};

export class LogEntryNotFound extends Error {
  constructor() {
    super("No such entry in the Action Log");
  }
}
/** The row is linked to a Case already: a run is linked once. */
export class AlreadyLinked extends Error {
  constructor() {
    super("That run is already linked to a Case");
  }
}
/** Nothing in the text is an Observable the action takes. */
export class NothingToRun extends Error {}

/** How the Action Log names a Response Action by what it did: "IOC alert", "Block domain". */
function responseActionName(r: { kind: ResponseActionKind; falconAction: string | null; targetType: string }) {
  switch (r.kind) {
    case "falcon_ioc":
      return r.falconAction === "prevent" ? centerActionLabel.prevent : centerActionLabel.detect;
    case "mimecast_blocked_sender":
      return r.targetType === "domain" ? centerActionLabel.block_domain : centerActionLabel.block_sender;
    case "umbrella_destination":
      return centerActionLabel.add_to_destination_list;
    case "falcon_containment":
      return centerActionLabel.contain;
    case "falcon_containment_lift":
      return centerActionLabel.lift_containment;
  }
}

/** Which Provider runs each Response Action. */
const providerOf: Record<CenterResponseAction, "crowdstrike" | "mimecast" | "umbrella"> = {
  detect: "crowdstrike",
  prevent: "crowdstrike",
  block_sender: "mimecast",
  block_domain: "mimecast",
  add_to_destination_list: "umbrella",
};

const statusText: Record<CardStatus, string> = {
  ready: "Ready",
  off: "Response Actions off",
  paused: "Paused",
  no_list: "No destination list chosen",
  unconfigured: "Not configured",
  no_key: "No VirusTotal key",
  admin_only: "Admins only",
};

export function actionCenterStore(
  { db, clock }: { db: Db; clock: Clock },
  modules: {
    responseActions: ResponseActionStore;
    observables: ObservableStore;
    ipLookups: IpLookupStore;
    hashLookups: HashLookupStore;
    domainUrlLookups: DomainUrlLookupStore;
    umbrellaChecks: UmbrellaDomainCheckStore;
  },
) {
  /** Every action, per Integration where one runs it, and whether each can run now. */
  async function catalogue(me: Membership): Promise<CatalogueCard[]> {
    const isAdmin = organizationPolicy.canManageIgnoredObservables(me);
    const rows = await db
      .select()
      .from(integrations)
      .where(and(eq(integrations.organizationId, me.organizationId), isNull(integrations.deletedAt)))
      .orderBy(asc(integrations.createdAt), asc(integrations.id));
    const key = await modules.hashLookups.key(me);
    const cards: CatalogueCard[] = [];
    const card = (c: Omit<CatalogueCard, "group" | "label" | "accepts" | "statusText" | "adminOnly"> & { adminOnly?: boolean; statusText?: string }) =>
      cards.push({
        group: centerActionGroup[c.action],
        label: centerActionLabel[c.action],
        accepts: centerActionAccepts[c.action],
        ...c,
        adminOnly: c.adminOnly ?? false,
        statusText: c.statusText ?? statusText[c.status],
      });

    for (const action of ["detect", "prevent", "block_sender", "block_domain", "add_to_destination_list"] as const) {
      const provider = providerOf[action];
      const of = rows.filter((r) => r.provider === provider);
      if (!of.length) {
        card({ action, integration: null, through: providerLabel[provider], status: "unconfigured", statusText: `No ${providerLabel[provider]} Integration`, settings: [] });
        continue;
      }
      for (const r of of) {
        const status: CardStatus = !r.responseActions ? "off" : r.paused ? "paused" : provider === "umbrella" && !r.destinationList ? "no_list" : "ready";
        const d = r.responseActionDefaults;
        const settings =
          provider === "crowdstrike"
            ? [
                { label: "Action", value: action === "prevent" ? "Prevent" : "Detect" },
                { label: "Severity", value: d.severity === "case" ? "The Case's, or High with no Case" : severityLabel[d.severity] },
                {
                  label: "Platforms",
                  value: d.platforms.length === FALCON_IOC_PLATFORMS.length ? "Windows, macOS, Linux" : d.platforms.map((p) => falconIocPlatformLabel[p]).join(", "),
                },
                { label: "Applies", value: "Globally" },
              ]
            : provider === "mimecast"
              ? [
                  { label: "Policy", value: "Organization-wide Blocked Senders" },
                  { label: "Blocks", value: action === "block_domain" ? "Every sender at the address's domain" : "The address itself" },
                ]
              : r.destinationList
                ? [{ label: "List", value: `${r.destinationList.name} (${r.destinationList.access === "block" ? "Block" : "Allow"})` }]
                : [];
        card({ action, integration: { id: r.id, name: r.name }, through: `${providerLabel[provider]} · ${r.name}`, status, settings });
      }
    }
    const crowdstrike = rows.filter((r) => r.provider === "crowdstrike");
    for (const action of ["contain", "lift_containment"] as const) {
      const adminOnly = action === "lift_containment";
      if (!crowdstrike.length) {
        card({ action, integration: null, through: providerLabel.crowdstrike, status: "unconfigured", statusText: "No CrowdStrike Integration", settings: [], adminOnly });
        continue;
      }
      for (const r of crowdstrike) {
        const status: CardStatus = adminOnly && !isAdmin ? "admin_only" : !r.hostContainment ? "off" : r.paused ? "paused" : "ready";
        card({
          action,
          integration: { id: r.id, name: r.name },
          through: `${providerLabel.crowdstrike} · ${r.name}`,
          status,
          statusText: status === "off" ? "Host containment off" : undefined,
          settings: [
            { label: "Targets", value: "One Falcon device (aid) of a host linked to a Case" },
            { label: "Before sending", value: "Reads the host from Falcon again for you to confirm" },
          ],
          adminOnly,
        });
      }
    }
    const ipinfo = rows.find((r) => r.provider === "ipinfo");
    card({
      action: "ip_lookup",
      integration: ipinfo ? { id: ipinfo.id, name: ipinfo.name } : null,
      through: ipinfo ? `IPinfo · ${ipinfo.name}` : "IPinfo",
      status: !ipinfo ? "unconfigured" : ipinfo.paused ? "paused" : "ready",
      statusText: !ipinfo ? "No IPinfo Integration" : undefined,
      settings: [{ label: "Never sent", value: "Private and reserved addresses" }],
    });
    for (const action of ["hash_lookup", "domain_url_lookup"] as const) {
      card({
        action,
        integration: null,
        through: "VirusTotal · your key",
        status: key ? "ready" : "no_key",
        statusText: key ? `Your key (${key.hint})` : undefined,
        settings: [
          ...(key ? [] : [{ label: "Your key", value: "None set: add yours in Your settings to look up what Argus hasn't cached" }]),
          action === "hash_lookup" ? { label: "Sent", value: "The hash only, never a file" } : { label: "URLs", value: "Looked up, never submitted for scanning" },
        ],
      });
    }
    const umbrella = rows.filter((r) => r.provider === "umbrella");
    card({
      action: "umbrella_check",
      integration: null,
      through: "Cisco Umbrella",
      status: umbrella.length ? "ready" : "unconfigured",
      statusText: umbrella.length ? `${umbrella.length} Integration${umbrella.length === 1 ? "" : "s"}` : "No Cisco Umbrella Integration",
      settings: [{ label: "Sent to Cisco", value: "Nothing: the lists are read and matched in Argus" }],
    });
    card({ action: "mark_important", integration: null, through: "Argus", status: "ready", settings: [{ label: "Effect", value: "Relates Alerts to Cases for the whole Organization" }] });
    card({
      action: "ignore",
      integration: null,
      through: "Argus",
      status: isAdmin ? "ready" : "admin_only",
      adminOnly: true,
      settings: [{ label: "Effect", value: "Never the basis of a Correlation" }],
    });
    return cards;
  }

  /** The Case `number` that `me` can see, unless `number` is null. */
  async function caseOf(me: Membership, number: number | null | undefined) {
    if (number === null || number === undefined) return null;
    const [found] = await db
      .select({ id: cases.id, number: cases.number, title: cases.title })
      .from(cases)
      .where(and(visibleCases(me), eq(cases.number, number)))
      .limit(1);
    return found ?? null;
  }

  /** Links `values` to Case `number` by hand, as Bulk Lookup's Link to Case does. Returns each value's Observable id. */
  async function linkValues(me: Membership, number: number, values: readonly { type: ObservableType; value: string }[]) {
    const now = clock.now();
    return db.transaction(async (tx) => {
      const current = await lockCase(tx, me, number);
      const ids: string[] = [];
      for (const v of values) {
        const normalised = normaliseObservable(v.type, v.value);
        if (!normalised) throw new InvalidValue(`${observableTypeLabel[v.type]}: ${v.value}`);
        ids.push((await linkObservable(tx, me, current, v.type, normalised, now)).itemId);
      }
      return ids;
    });
  }

  /** The Observable the Organization holds for this value, if it does. */
  async function heldId(me: Membership, type: ObservableType, value: string) {
    const normalised = normaliseObservable(type, value);
    if (!normalised) return null;
    const [found] = await db
      .select({ id: observables.id })
      .from(observables)
      .where(and(eq(observables.organizationId, me.organizationId), eq(observables.type, type), eq(observables.matchKey, normalised.key)));
    return found?.id ?? null;
  }

  /** Runs lookup `action` on one value, logs it, and says how it went. */
  async function lookUp(me: Membership, action: CenterLookup, v: { type: ObservableType; value: string }, caseId: string | null): Promise<RunValue> {
    const started = clock.now();
    let logged: LogAction = "ip_lookup";
    let outcome: LogOutcome;
    let detail: string | null = null;
    let integrationId: string | null = null;
    const fresh = (fetchedAt: string | null) => (fetchedAt && new Date(fetchedAt) < started ? "cached" : "done");
    try {
      if (action === "ip_lookup") {
        const l = await modules.ipLookups.lookup(me, v.value);
        outcome = l.state === "failed" || l.state === "unconfigured" || l.state === "paused" ? "failed" : l.state === "reserved" ? "done" : fresh(l.fetchedAt);
        detail =
          l.state === "reserved" ? `${l.reserved?.label ?? "Reserved"} address: never sent to IPinfo`
          : l.state === "unconfigured" ? "The Organization has no IPinfo Integration"
          : l.state === "paused" ? "The IPinfo Integration is paused"
          : l.error;
      } else if (action === "hash_lookup") {
        logged = "hash_lookup";
        const l = await modules.hashLookups.lookup(me, v.value);
        outcome = l.state === "failed" || l.state === "no_key" ? "failed" : fresh(l.fetchedAt);
        detail = l.state === "no_key" ? "Nothing is cached, and you have no VirusTotal key" : l.state === "not_found" ? "VirusTotal has never seen this file" : l.error;
      } else if (action === "domain_url_lookup") {
        const l = v.type === "url" ? await modules.domainUrlLookups.lookupUrl(me, v.value) : await modules.domainUrlLookups.lookupDomain(me, v.value);
        logged = v.type === "url" ? "url_lookup" : "domain_lookup";
        outcome = l.state === "failed" || l.state === "no_key" || l.state === "withheld" ? "failed" : fresh(l.fetchedAt);
        detail =
          l.state === "withheld" ? l.withheld
          : l.state === "no_key" ? "Nothing is cached, and you have no VirusTotal key"
          : l.state === "not_found" ? "VirusTotal has never seen it"
          : l.error;
      } else {
        logged = "umbrella_check";
        const check = await modules.umbrellaChecks.check(me, v.value);
        const failed = check.integrations.find((i) => i.state === "failed");
        const matches = check.integrations.flatMap((i) => i.matches);
        outcome = !check.integrations.length || failed ? "failed" : "done";
        integrationId = check.integrations.length === 1 ? check.integrations[0]!.integration.id : null;
        detail = !check.integrations.length
          ? "The Organization has no Cisco Umbrella Integration"
          : failed
            ? failed.error
            : matches.length
              ? `On ${matches.length} destination list${matches.length === 1 ? "" : "s"}`
              : "On no destination list";
      }
    } catch (e) {
      outcome = "failed";
      detail = e instanceof Error ? e.message : String(e);
    }
    await logRun(db, {
      organizationId: me.organizationId,
      action: logged,
      observableId: await heldId(me, v.type, v.value),
      valueType: v.type,
      value: v.value,
      integrationId,
      caseId,
      source: "action_center",
      outcome,
      detail,
      actorId: me.userId,
      at: started,
    });
    return { ...v, outcome, detail };
  }

  /** Runs action `input.action` on each value pulled out of `input.text`, as ADR 0016 has it. */
  async function run(me: Membership, input: RunInput): Promise<RunResult> {
    const extracted = extractObservables(input.text);
    if (!extracted.ok) throw new NothingToRun(extracted.reason);
    const accepts = centerActionAccepts[input.action];
    const values: RunValue[] = [];
    const accepted: { type: ObservableType; value: string }[] = [];
    for (const o of extracted.observables) {
      if (accepts.includes(o.type)) accepted.push(o);
      else values.push({ ...o, outcome: "skipped", detail: `${centerActionLabel[input.action]} takes no ${observableTypeLabel[o.type]}` });
    }
    if (!accepted.length) {
      throw new NothingToRun(
        extracted.observables.length
          ? `${centerActionLabel[input.action]} takes ${accepts.map((t) => (t === "host" ? "Host" : observableTypeLabel[t])).join(", ")}; none of these is one`
          : "No value Argus knows was found in that text",
      );
    }
    const theCase = await caseOf(me, input.caseNumber);
    if (input.caseNumber != null && !theCase) throw new CaseNotVisible();
    const caseView = theCase ? { number: theCase.number, title: theCase.title } : null;

    if (isCenterResponseAction(input.action)) {
      const { ids, skipped } = await modules.responseActions.takeValues(me, {
        values: accepted,
        number: theCase?.number ?? null,
        reason: input.reason ?? null,
        integrationIds: input.integrationIds ?? [],
        action: input.action,
        internal: theCase ? input.internal : undefined,
        confirmIgnored: input.confirmIgnored,
      });
      const skippedKeys = new Map(skipped.map((s: Skipped) => [`${s.observable.type}:${s.observable.value}`, s.reason]));
      for (const v of accepted) {
        const reason = skippedKeys.get(`${v.type}:${v.value}`);
        values.push({ ...v, outcome: reason ? "skipped" : "taken", detail: reason ?? null });
      }
      return { values, responseActionIds: ids, case: caseView };
    }

    if (theCase) await linkValues(me, theCase.number, accepted);
    if (isCenterLookup(input.action)) {
      for (const v of accepted) values.push(await lookUp(me, input.action, v, theCase?.id ?? null));
      return { values, responseActionIds: [], case: caseView };
    }

    // Marks: Important for any Member, Ignore for Admins.
    if (input.action === "ignore" && !organizationPolicy.canManageIgnoredObservables(me)) throw new NotPermitted("Only Admins can put Observables on the Ignored list");
    for (const v of accepted) {
      const changed =
        input.action === "ignore"
          ? await modules.observables.setIgnoredByValue(me, v.type, v.value, true, { source: "action_center", caseId: theCase?.id ?? null })
          : await modules.observables.setImportantByValue(me, v.type, v.value, true, { source: "action_center", caseId: theCase?.id ?? null });
      values.push({ ...v, outcome: changed ? "done" : "unchanged", detail: changed ? null : input.action === "ignore" ? "Already on the Ignored list" : "Already Important" });
    }
    return { values, responseActionIds: [], case: caseView };
  }

  /** The Action Log, newest first, without rows linked to Cases `me` can't see. */
  async function log(me: Membership, filter: LogFilter = {}): Promise<{ entries: LogEntry[]; more: boolean }> {
    const limit = Math.min(filter.limit ?? 100, 500);
    const l = actionLog;
    const before = filter.before
      ? (await db.select({ seq: l.seq }).from(l).where(and(eq(l.id, filter.before), eq(l.organizationId, me.organizationId))))[0]?.seq
      : undefined;
    const groupActions = filter.group
      ? (Object.entries(logActionGroup).filter(([, g]) => g === filter.group).map(([a]) => a) as LogAction[])
      : null;
    const where: (SQL | undefined)[] = [
      eq(l.organizationId, me.organizationId),
      or(isNull(l.caseId), visibleCases(me)),
      filter.link === "linked" ? isNotNull(l.caseId) : filter.link === "unlinked" ? isNull(l.caseId) : undefined,
      groupActions ? inArray(l.action, groupActions) : undefined,
      filter.byId ? eq(l.actorId, filter.byId) : undefined,
      before !== undefined ? lt(l.seq, before) : undefined,
    ];
    const rows = await db
      .select({
        row: l,
        caseNumber: cases.number,
        caseTitle: cases.title,
        byName: user.name,
        integrationName: integrations.name,
        ra: responseActions,
      })
      .from(l)
      .leftJoin(cases, eq(l.caseId, cases.id))
      .innerJoin(user, eq(l.actorId, user.id))
      .leftJoin(integrations, eq(l.integrationId, integrations.id))
      .leftJoin(responseActions, eq(l.responseActionId, responseActions.id))
      .where(and(...where))
      .orderBy(desc(l.seq))
      .limit(limit + 1);
    const entries = rows.slice(0, limit).map(({ row, caseNumber, caseTitle, byName, integrationName, ra }): LogEntry => {
      const noCase = ra ? ra.caseId === null : false;
      return {
        id: row.id,
        at: row.createdAt.toISOString(),
        action: row.action,
        group: logActionGroup[row.action],
        label: ra ? responseActionName(ra) : logActionLabel[row.action],
        value: { type: row.valueType, value: row.value },
        observableId: row.observableId,
        assetId: row.assetId,
        integration: row.integrationId && integrationName ? { id: row.integrationId, name: integrationName } : null,
        case: caseNumber !== null && caseTitle !== null ? { number: caseNumber, title: caseTitle } : null,
        by: { id: row.actorId, name: byName },
        source: row.source,
        state: ra ? ra.state : row.outcome!,
        detail: ra ? (ra.state === "failed" ? ra.lastError : (ra.lastError ?? ra.reason)) : row.detail,
        responseAction: ra
          ? {
              id: ra.id,
              kind: ra.kind,
              origin: ra.origin,
              reason: ra.reason,
              error: ra.lastError,
              retryable: noCase && ra.state === "failed",
              removable: noCase && ra.state === "active" && ra.origin === "created" && ra.kind !== "falcon_containment_lift",
              dismissable: noCase && ra.state === "active" && ra.origin !== "created" && ra.kind !== "falcon_containment_lift",
            }
          : null,
      };
    });
    return { entries, more: rows.length > limit };
  }

  /** The log row `id` of `me`'s Organization, not on a Case they can't see. */
  async function entry(me: Membership, id: string) {
    const [found] = await db
      .select({ row: actionLog })
      .from(actionLog)
      .leftJoin(cases, eq(actionLog.caseId, cases.id))
      .where(and(eq(actionLog.id, id), eq(actionLog.organizationId, me.organizationId), or(isNull(actionLog.caseId), visibleCases(me))));
    if (!found) throw new LogEntryNotFound();
    return found.row;
  }

  return {
    catalogue,
    run,
    log,

    /**
     * Links run `id`, which has no Case, to Case `number`. A Response Action moves to the Case for
     * good; a mark or lookup's value is linked to the Case and its row names it.
     */
    async linkToCase(me: Membership, id: string, number: number) {
        const row = await entry(me, id);
      if (row.caseId) throw new AlreadyLinked();
      if (row.responseActionId) {
        await modules.responseActions.linkToCase(me, row.responseActionId, number);
        return;
      }
      const now = clock.now();
      await db.transaction(async (tx) => {
        const current = await lockCase(tx, me, number);
        const type = row.valueType as ObservableType;
        const normalised = normaliseObservable(type, row.value);
        if (normalised) await linkObservable(tx, me, current, type, normalised, now);
        const [linked] = await tx
          .update(actionLog)
          .set({ caseId: current.id })
          .where(and(eq(actionLog.id, id), isNull(actionLog.caseId)))
          .returning({ id: actionLog.id });
        if (!linked) throw new AlreadyLinked();
        await publish(tx, { kind: "actions", organizationId: me.organizationId });
      });
    },

    /** Retries, removes or dismisses the Response Action of run `id`, which has no Case. */
    async responseAction(me: Membership, id: string, op: "retry" | "remove" | "dismiss", { confirmRelying = false } = {}) {
        const row = await entry(me, id);
      if (!row.responseActionId) throw new LogEntryNotFound();
      if (op === "retry") await modules.responseActions.retryWithoutCase(me, row.responseActionId);
      else if (op === "remove") await modules.responseActions.removeWithoutCase(me, row.responseActionId, { confirmRelying });
      else await modules.responseActions.dismissWithoutCase(me, row.responseActionId);
    },
  };
}

/** The Case asked for isn't one `me` can see. */
export class CaseNotVisible extends Error {
  constructor() {
    super("Case not found");
  }
}

export type ActionCenterStore = ReturnType<typeof actionCenterStore>;
