import { useState } from "react";
import { useTranslation } from "react-i18next";
import { command, type Instance } from "../../lib/launcher";
import { normalizeError } from "../../lib/errors";
import { Button } from "../../components/ui/Button";
import { Select } from "../../components/ui/Select";
import type { ModpackUpdateCheck, PackConflictReason, PackUpdatePlan, PackUpdateResult } from "./types";
import { errorText, sizeText } from "./utils";
import { formatDate } from "../../i18n/format";

const unmanagedReasonKey: Record<NonNullable<ModpackUpdateCheck["reason"]>, string> = {
  noLock: "library:modpackUpdate.unmanaged.noLock",
  legacyLock: "library:modpackUpdate.unmanaged.legacyLock",
  noSource: "library:modpackUpdate.unmanaged.noSource",
  invalidLock: "library:modpackUpdate.unmanaged.invalidLock",
};

const conflictReasonKey: Record<PackConflictReason, string> = {
  userModified: "library:modpackUpdate.plan.conflictReason.userModified",
  userDeleted: "library:modpackUpdate.plan.conflictReason.userDeleted",
  userAdded: "library:modpackUpdate.plan.conflictReason.userAdded",
  userModifiedRemovedUpstream: "library:modpackUpdate.plan.conflictReason.userModifiedRemovedUpstream",
};

export function ModpackUpdate({
  instance,
  onChanged,
  onBackupsChanged,
  onRecoveryFault,
}: {
  instance: Instance;
  onChanged: () => Promise<void>;
  onBackupsChanged: () => Promise<void>;
  onRecoveryFault: (error: unknown) => void;
}) {
  const { t, i18n } = useTranslation();
  const [check, setCheck] = useState<ModpackUpdateCheck | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [selectedVersionId, setSelectedVersionId] = useState("");
  const [includeOptional, setIncludeOptional] = useState(false);
  const [plan, setPlan] = useState<PackUpdatePlan | null>(null);
  const [choices, setChoices] = useState<Record<string, boolean>>({});
  const [regenerated, setRegenerated] = useState(false);
  const [appliedVersion, setAppliedVersion] = useState("");
  const [keptDirectory, setKeptDirectory] = useState("");

  const checkForUpdate = async (preserveApplied = false) => {
    setBusy(true);
    setError("");
    if (!preserveApplied) setAppliedVersion("");
    setPlan(null);
    setChoices({});
    setRegenerated(false);
    try {
      const result = await command<ModpackUpdateCheck>("check_modpack_update", { instanceId: instance.id });
      setCheck(result);
      setSelectedVersionId(result.newer[0]?.id ?? "");
      setIncludeOptional(result.includeOptional);
    } catch (fault) {
      setCheck(null);
      setError(errorText(normalizeError(fault).code, t));
    } finally {
      setBusy(false);
    }
  };

  const updateFailureText = (failure: ReturnType<typeof normalizeError>) => {
    if (failure.params.kind === "packUpdate") {
      if (failure.code === "backup.restoreRecoveryRequired") return t("library:modpackUpdate.recoveryRequired");
      if (failure.code === "backup.restoreRolledBack") return t("library:modpackUpdate.rolledBack");
    }
    return errorText(failure.code, t);
  };

  const loadPlan = async (versionId: string, optional: boolean, again: boolean) => {
    if (!versionId) return;
    setBusy(true);
    setError("");
    setAppliedVersion("");
    try {
      const result = await command<PackUpdatePlan>("plan_modpack_update", {
        instanceId: instance.id,
        newVersionId: versionId,
        includeOptional: optional,
      });
      setPlan(result);
      setChoices(Object.fromEntries(result.conflicts.map((conflict) => [conflict.path, false])));
      setRegenerated(again);
      setSelectedVersionId(versionId);
      setIncludeOptional(result.includeOptional);
    } catch (fault) {
      setPlan(null);
      setRegenerated(false);
      setError(errorText(normalizeError(fault).code, t));
    } finally {
      setBusy(false);
    }
  };

  const applyUpdate = () => {
    if (!plan || busy || !window.confirm(t("library:modpackUpdate.plan.confirm"))) return;
    const approved = plan;
    void (async () => {
      setBusy(true);
      setError("");
      setAppliedVersion("");
      setKeptDirectory("");
      try {
        const result = await command<PackUpdateResult>("apply_modpack_update", {
          instanceId: instance.id,
          newVersionId: approved.to.versionId,
          includeOptional: approved.includeOptional,
          fingerprint: approved.fingerprint,
          choices: approved.conflicts.map((conflict) => ({
            path: conflict.path,
            useUpstream: choices[conflict.path] === true,
          })),
        });
        setPlan(null);
        setChoices({});
        setRegenerated(false);
        setAppliedVersion(approved.to.versionNumber);
        setKeptDirectory(result.previousDirectory ?? "");
        await onChanged();
        await onBackupsChanged();
        await checkForUpdate(true);
      } catch (fault) {
        const failure = normalizeError(fault);
        if (failure.code === "modpack.planChanged") {
          await loadPlan(approved.to.versionId, approved.includeOptional, true);
        } else {
          setError(updateFailureText(failure));
          if (failure.code === "backup.restoreRecoveryRequired" || failure.code === "backup.restoreRolledBack") {
            onRecoveryFault(fault);
          }
          await onBackupsChanged();
        }
      } finally {
        setBusy(false);
      }
    })();
  };

  const currentVersion = check?.current?.versionNumber ?? check?.current?.versionId ?? "—";
  const dependencyChange = plan?.dependencyChange;
  const dependencyEntries = dependencyChange
    ? [...new Set([...Object.keys(dependencyChange.from), ...Object.keys(dependencyChange.to)])]
        .filter((key) => dependencyChange.from[key] !== dependencyChange.to[key])
        .sort()
        .map((key) => ({ key, from: dependencyChange.from[key], to: dependencyChange.to[key] }))
    : [];

  return (
    <section className="vx-detail-section">
      <h2>{t("library:modpackUpdate.title")}</h2>
      <div className="vx-action-row">
        <Button variant="secondary" onClick={() => void checkForUpdate()} disabled={busy}>
          {t("library:modpackUpdate.check")}
        </Button>
      </div>
      {error ? <p role="alert">{error}</p> : null}
      {appliedVersion ? (
        <p className="vx-inline-notice" role="status">
          {t("library:modpackUpdate.applied", { version: appliedVersion })}
        </p>
      ) : null}
      {appliedVersion && keptDirectory ? (
        <p className="vx-inline-notice">
          {t("library:modpackUpdate.previousKept")} <span className="vx-path">{keptDirectory}</span>
        </p>
      ) : null}
      {check ? (
        !check.managed ? (
          <p className="vx-inline-notice">{t(unmanagedReasonKey[check.reason ?? "invalidLock"])}</p>
        ) : check.newer.length === 0 ? (
          <>
            <p>{t("library:modpackUpdate.upToDate", { version: currentVersion })}</p>
            {check.currentMissing ? (
              <p className="vx-inline-notice">{t("library:modpackUpdate.currentMissing")}</p>
            ) : null}
          </>
        ) : (
          <div className="vx-detail-stack">
            {check.currentMissing ? (
              <p className="vx-inline-notice">{t("library:modpackUpdate.currentMissingChoose")}</p>
            ) : null}
            <div className="vx-action-row">
              <Select
                aria-label={t("library:modpackUpdate.versionToInstall")}
                value={selectedVersionId}
                onChange={(value) => {
                  setSelectedVersionId(value);
                  setPlan(null);
                  setChoices({});
                  setRegenerated(false);
                }}
                disabled={busy}
                options={check.newer.map((version) => ({
                  value: version.id,
                  label: `${version.versionNumber} · ${formatDate(version.datePublished, i18n.language)}`,
                }))}
              />
              <Button
                variant="secondary"
                disabled={busy || !selectedVersionId}
                onClick={() => void loadPlan(selectedVersionId, includeOptional, false)}
              >
                {t("library:modpackUpdate.showPlan")}
              </Button>
            </div>
            <div className="vx-check-grid">
              <label>
                <input
                  type="checkbox"
                  checked={includeOptional}
                  disabled={busy}
                  onChange={(event) => {
                    setIncludeOptional(event.target.checked);
                    setPlan(null);
                    setChoices({});
                    setRegenerated(false);
                  }}
                />{" "}
                {t("library:modpackUpdate.includeOptional")}
              </label>
            </div>
            {plan ? (
              <div className="vx-detail-stack" data-update-plan>
                <h3>{t("library:modpackUpdate.plan.title")}</h3>
                {regenerated ? (
                  <p className="vx-inline-notice" role="status">
                    {t("library:modpackUpdate.plan.regenerated")}
                  </p>
                ) : null}
                <p>{t("library:modpackUpdate.plan.fromTo", { from: plan.from.versionNumber, to: plan.to.versionNumber })}</p>
                <p>
                  {t("library:modpackUpdate.plan.counts", {
                    added: plan.add,
                    replaced: plan.replace,
                    removed: plan.remove,
                    unchanged: plan.unchanged,
                  })}
                </p>
                <p>{t("library:modpackUpdate.plan.downloadSize", { size: sizeText(plan.downloadBytes, i18n.language) })}</p>
                {dependencyChange ? (
                  <div>
                    <p>{t("library:modpackUpdate.plan.dependencyChange")}</p>
                    <ul>
                      {dependencyEntries.map((entry) => (
                        <li key={entry.key}>
                          {t("library:modpackUpdate.plan.dependencyEntry", {
                            key: entry.key,
                            from: entry.from ?? "—",
                            to: entry.to ?? "—",
                          })}
                        </li>
                      ))}
                    </ul>
                  </div>
                ) : null}
                {plan.droppedIntents.length ? (
                  <div className="vx-inline-notice" role="status">
                    <p>{t("library:modpackUpdate.plan.droppedIntents")}</p>
                    <ul>
                      {plan.droppedIntents.map((path) => (
                        <li className="vx-path" key={path}>{path}</li>
                      ))}
                    </ul>
                  </div>
                ) : null}
                {plan.kept.length ? (
                  <div className="vx-inline-notice" role="status">
                    <p>{t("library:modpackUpdate.plan.kept")}</p>
                    <ul>
                      {plan.kept.map((path) => (
                        <li className="vx-path" key={path}>{path}</li>
                      ))}
                    </ul>
                  </div>
                ) : null}
                {plan.optionalRemoved.length ? (
                  <div className="vx-inline-notice" role="status">
                    <p>{t("library:modpackUpdate.plan.optionalRemoved")}</p>
                    <ul>
                      {plan.optionalRemoved.map((path) => (
                        <li className="vx-path" key={path}>{path}</li>
                      ))}
                    </ul>
                  </div>
                ) : null}
                <p>{t("library:modpackUpdate.plan.skipped", { count: plan.skipped.length })}</p>
                {plan.conflicts.length ? (
                  <div>
                    <p>{t("library:modpackUpdate.plan.conflicts")}</p>
                    <p>{t("library:modpackUpdate.plan.conflictHint")}</p>
                    <ul>
                      {plan.conflicts.map((conflict) => (
                        <li className="vx-path" key={conflict.path}>
                          <span>{conflict.path}</span>{" "}
                          <span>{t(conflictReasonKey[conflict.reason])}</span>{" "}
                          <label>
                            <input
                              type="checkbox"
                              data-conflict-path={conflict.path}
                              checked={choices[conflict.path] === true}
                              disabled={busy}
                              onChange={(event) => setChoices((previous) => ({
                                ...previous,
                                [conflict.path]: event.target.checked,
                              }))}
                            />{" "}
                            {t("library:modpackUpdate.plan.useUpstream")}
                          </label>
                        </li>
                      ))}
                    </ul>
                  </div>
                ) : null}
                <Button variant="primary" disabled={busy} onClick={applyUpdate}>
                  {t("library:modpackUpdate.plan.apply")}
                </Button>
              </div>
            ) : null}
          </div>
        )
      ) : null}
    </section>
  );
}
