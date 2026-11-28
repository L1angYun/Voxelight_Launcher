import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { useTranslation } from "react-i18next";
import { Button } from "../components/ui/Button";
import { Dialog } from "../components/ui/Dialog";

/**
 * A page can register a leave guard while it holds unsaved work. The shell asks
 * `requestLeave()` before it changes pages; the guard only blocks when at least
 * one registered page section reports itself as dirty or is still saving.
 *
 * A page that swaps parts of itself (Settings sections) wraps them in a
 * `LeaveGuardScope`. Their registrations still guard leaving the page, and the
 * scope can also ask about only its own registrations before such a swap, with
 * the same Save, Discard and Stay choices applied to just those parts.
 */
export type LeaveGuardSaveResult = { ok: true } | { ok: false; message?: string };
export type LeaveGuardSaveOutcome = void | boolean | LeaveGuardSaveResult;
export type LeaveGuardSaveHandler = () => LeaveGuardSaveOutcome | Promise<LeaveGuardSaveOutcome>;

export interface LeaveGuardActions {
  /**
   * Persist the page's draft. Reject, return false or `{ ok: false }` to stay.
   * When the page's own save is already running, return that running save
   * instead of starting a second one or reporting a failure.
   */
  save: LeaveGuardSaveHandler;
  /** Revert the page's draft. Called only after the user chooses Discard. */
  discard: () => void;
  /**
   * The page's own save that is still running, if any. Leaving waits for its
   * real outcome, and Discard is not offered while it runs.
   */
  running?: () => Promise<LeaveGuardSaveOutcome> | null;
}

export interface LeaveGuardController {
  /** Resolves true when leaving may proceed, false when the user stays. */
  requestLeave: () => Promise<boolean>;
}

type LeaveGuardRegistration = {
  isDirty: () => boolean;
  running: () => Promise<LeaveGuardSaveOutcome> | null;
  save: LeaveGuardSaveHandler;
  discard: () => void;
};

type RegistrationSource = () => Iterable<LeaveGuardRegistration>;
/** "page" names leaving the page; "section" names switching a part of it. */
type LeaveKind = "page" | "section";

type LeaveRequest = {
  promise: Promise<boolean>;
  resolve: (allowed: boolean) => void;
  source: RegistrationSource;
  kind: LeaveKind;
};

interface LeaveGuardContextValue extends LeaveGuardController {
  register: (registration: LeaveGuardRegistration) => () => void;
  /** Ask only about the registrations `source` returns. */
  requestLeaveWithin: (source: RegistrationSource, kind: LeaveKind) => Promise<boolean>;
}

const LeaveGuardContext = createContext<LeaveGuardContextValue | null>(null);

function outcomeOf(result: LeaveGuardSaveOutcome): LeaveGuardSaveResult {
  if (result === false) return { ok: false };
  if (typeof result === "object" && result !== null && !result.ok) return { ok: false, message: result.message };
  return { ok: true };
}

/** Never lets a rejection (or its detail text) escape: a rejected save is a generic failure. */
async function settle(run: () => LeaveGuardSaveOutcome | Promise<LeaveGuardSaveOutcome>): Promise<LeaveGuardSaveResult> {
  try {
    return outcomeOf(await run());
  } catch {
    return { ok: false };
  }
}

export function LeaveGuardProvider({ children }: { children?: ReactNode }) {
  const { t } = useTranslation();
  const registrations = useRef(new Set<LeaveGuardRegistration>());
  const [open, setOpen] = useState(false);
  const [saving, setSaving] = useState(false);
  // True while the prompt waits for a save the page started itself.
  const [waiting, setWaiting] = useState(false);
  const [error, setError] = useState<{ message?: string } | null>(null);
  const [recheck, setRecheck] = useState<LeaveRequest | null>(null);
  const [kind, setKind] = useState<LeaveKind>("page");
  const pending = useRef<LeaveRequest | null>(null);
  const everything = useCallback<RegistrationSource>(() => registrations.current, []);

  const register = useCallback((registration: LeaveGuardRegistration) => {
    registrations.current.add(registration);
    return () => {
      registrations.current.delete(registration);
    };
  }, []);

  const blocking = useCallback(
    (source: RegistrationSource) =>
      [...source()].filter((registration) => registration.isDirty() || registration.running() !== null),
    [],
  );

  const finish = useCallback((allowed: boolean) => {
    setOpen(false);
    setSaving(false);
    setWaiting(false);
    setError(null);
    setRecheck(null);
    const current = pending.current;
    pending.current = null;
    current?.resolve(allowed);
  }, []);

  const waitForRunning = useCallback(async (request: LeaveRequest, running: Promise<LeaveGuardSaveOutcome>[]) => {
    const outcomes = await Promise.all(running.map((promise) => settle(() => promise)));
    if (pending.current !== request) return;
    setWaiting(false);
    const failure = outcomes.find((outcome) => !outcome.ok);
    if (failure && !failure.ok) {
      setSaving(false);
      setError({ message: failure.message });
      return;
    }
    // Decide only after the pages have rendered what that save left behind.
    setRecheck(request);
  }, []);

  const openPrompt = useCallback((request: LeaveRequest, candidates: LeaveGuardRegistration[]) => {
    const running = candidates
      .map((registration) => registration.running())
      .filter((promise): promise is Promise<LeaveGuardSaveOutcome> => promise !== null);
    setOpen(true);
    setSaving(running.length > 0);
    setWaiting(running.length > 0);
    if (running.length) void waitForRunning(request, running);
  }, [waitForRunning]);

  const requestLeaveWithin = useCallback(function ask(source: RegistrationSource, leaveKind: LeaveKind): Promise<boolean> {
    const current = pending.current;
    if (current) {
      if (current.source === source) return current.promise;
      // Another part's prompt is open: answer it first, then check this one, so
      // allowing a section switch never also lets the whole page go unchecked.
      return current.promise.then((allowed) => (allowed ? ask(source, leaveKind) : false));
    }
    const candidates = blocking(source);
    if (!candidates.length) return Promise.resolve(true);
    let resolve!: (allowed: boolean) => void;
    const promise = new Promise<boolean>((settleLeave) => {
      resolve = settleLeave;
    });
    const request: LeaveRequest = { promise, resolve, source, kind: leaveKind };
    pending.current = request;
    setError(null);
    setKind(leaveKind);
    openPrompt(request, candidates);
    return promise;
  }, [blocking, openPrompt]);

  const requestLeave = useCallback(
    (): Promise<boolean> => requestLeaveWithin(everything, "page"),
    [everything, requestLeaveWithin],
  );

  useEffect(() => {
    if (!recheck || pending.current !== recheck) return;
    setRecheck(null);
    const candidates = blocking(recheck.source);
    if (!candidates.length) {
      finish(true);
      return;
    }
    openPrompt(recheck, candidates);
  }, [blocking, finish, openPrompt, recheck]);

  function stay() {
    // Staying never cancels a save the page started itself; it only keeps the page.
    if (saving && !waiting) return;
    finish(false);
  }

  function discard() {
    const request = pending.current;
    if (saving || !request) return;
    for (const registration of blocking(request.source)) {
      try {
        registration.discard();
      } catch {
        // A discard that cannot run must not trap the user in the dialog.
      }
    }
    finish(true);
  }

  async function save() {
    const request = pending.current;
    if (saving || !request) return;
    setSaving(true);
    setError(null);
    for (const registration of blocking(request.source)) {
      const outcome = await settle(() => registration.save());
      if (pending.current !== request) return;
      if (!outcome.ok) {
        setSaving(false);
        setError({ message: outcome.message });
        return;
      }
    }
    finish(true);
  }

  const context = useMemo<LeaveGuardContextValue>(
    () => ({ requestLeave, requestLeaveWithin, register }),
    [register, requestLeave, requestLeaveWithin],
  );

  return (
    <LeaveGuardContext.Provider value={context}>
      {children}
      {open ? (
        <Dialog
          open
          onOpenChange={(next) => {
            if (!next) stay();
          }}
          title={t("common:leaveGuard.title")}
          description={kind === "section" ? t("common:leaveGuard.sectionDescription") : t("common:leaveGuard.description")}
          closeLabel={t("common:a11y.closeDialog")}
          footer={
            <>
              <Button variant="ghost" disabled={saving && !waiting} onClick={stay}>
                {t("common:leaveGuard.stay")}
              </Button>
              <Button variant="secondary" disabled={saving} onClick={discard}>
                {t("common:leaveGuard.discard")}
              </Button>
              <Button variant="primary" loading={saving} onClick={() => void save()}>
                {t("common:actions.save")}
              </Button>
            </>
          }
        >
          {waiting ? (
            <p className="vx-settings-notice" role="status">
              {kind === "section" ? t("common:leaveGuard.sectionWaitingForSave") : t("common:leaveGuard.waitingForSave")}
            </p>
          ) : null}
          {error ? <p className="vx-settings-error" role="alert">{error.message?.trim() || t("common:leaveGuard.saveFailed")}</p> : null}
        </Dialog>
      ) : null}
    </LeaveGuardContext.Provider>
  );
}

/** Register unsaved work for as long as `dirty` is true. */
export function useLeaveGuard(dirty: boolean, actions: LeaveGuardActions): void {
  const context = useContext(LeaveGuardContext);
  const dirtyRef = useRef(dirty);
  dirtyRef.current = dirty;
  const actionsRef = useRef(actions);
  actionsRef.current = actions;

  useEffect(() => {
    if (!context) return;
    return context.register({
      isDirty: () => dirtyRef.current,
      running: () => actionsRef.current.running?.() ?? null,
      save: () => actionsRef.current.save(),
      discard: () => actionsRef.current.discard(),
    });
  }, [context]);
}

export interface LeaveGuardScopeHandle extends LeaveGuardController {
  /**
   * True while a request would have to ask: something registered in this
   * scope is dirty or still saving.
   */
  blocked: () => boolean;
  /** The context `LeaveGuardScope` provides to the parts it covers. */
  readonly context: LeaveGuardContextValue | null;
}

/**
 * A scope of the leave guard. Pass it to `<LeaveGuardScope>` around the parts it
 * covers. Its `requestLeave()` asks about only their registrations, under the
 * section copy, and Save or Discard act on only them.
 */
export function useLeaveGuardScope(): LeaveGuardScopeHandle {
  const parent = useContext(LeaveGuardContext);
  const registrations = useRef(new Set<LeaveGuardRegistration>());
  const source = useCallback<RegistrationSource>(() => registrations.current, []);
  const context = useMemo<LeaveGuardContextValue | null>(() => parent && {
    requestLeave: parent.requestLeave,
    requestLeaveWithin: parent.requestLeaveWithin,
    register: (registration) => {
      registrations.current.add(registration);
      const unregister = parent.register(registration);
      return () => {
        registrations.current.delete(registration);
        unregister();
      };
    },
  }, [parent]);
  const requestLeave = useCallback(
    () => (parent ? parent.requestLeaveWithin(source, "section") : Promise.resolve(true)),
    [parent, source],
  );
  const blocked = useCallback(
    () => [...registrations.current].some((registration) => registration.isDirty() || registration.running() !== null),
    [],
  );
  return useMemo(() => ({ requestLeave, blocked, context }), [blocked, context, requestLeave]);
}

/** Registrations below this component belong to `scope` as well as to the page. */
export function LeaveGuardScope({ scope, children }: { scope: LeaveGuardScopeHandle; children?: ReactNode }) {
  return <LeaveGuardContext.Provider value={scope.context}>{children}</LeaveGuardContext.Provider>;
}

/** The navigation side of the guard. Must be used below `LeaveGuardProvider`. */
export function useLeaveGuardController(): LeaveGuardController {
  const context = useContext(LeaveGuardContext);
  if (!context) {
    throw new Error("useLeaveGuardController requires LeaveGuardProvider");
  }
  return context;
}

/**
 * Shares one running save between its button and the leave guard: a second
 * call while it runs gets the same promise, and `current()` reports it.
 */
export function useSharedSave<T>() {
  const running = useRef<Promise<T> | null>(null);
  const run = useCallback((task: () => Promise<T>): Promise<T> => {
    if (running.current) return running.current;
    const promise = task().finally(() => {
      if (running.current === promise) running.current = null;
    });
    running.current = promise;
    return promise;
  }, []);
  const current = useCallback(() => running.current, []);
  return useMemo(() => ({ run, current }), [current, run]);
}
