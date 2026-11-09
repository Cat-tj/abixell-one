/**
 * Epic 4 Wave 2 §4.4 steps 12–14 — batch assignment of internal access.
 *
 * One selection set becomes one preview and one confirmation (§4.4 C). The
 * preview is a real server round trip, not a client-side echo: it resolves
 * every pair against the same policy the confirmation will run and returns a
 * content hash binding actor, target, and pairs. The confirmation submits the
 * exact previewed pairs with that hash, so a mid-flow change cannot be
 * committed under an earlier approval.
 *
 * After the server accepts the batch no UI path repeats the POST; verification
 * is a GET reload of the target's authoritative access, and a failure there
 * offers "retry verification" only.
 */
import { useCallback, useRef, useState } from "react";
import { useAuth } from "../../../auth/AuthContext";
import { useT } from "../../../i18n/LocaleProvider";
import {
  api,
  ApiError,
  type AdminAssignmentBatchPreview,
  type AdminRoleAssignmentInput,
} from "../../../lib/api";
import { Alert, Button, Spinner } from "../../../shell/components/ui";
import { OverlayDialog } from "../../../shell/components/OverlayDialog";
import {
  AssignmentPairEditor,
  assignmentPairKey,
  errorMessage,
  useAssignmentOptions,
} from "./AdminAssignmentControls";

type Step =
  | "edit"
  | "previewing"
  | "review"
  | "pending"
  | "failed"
  | "unknown-outcome"
  | "verification-failed"
  | "success";

type Translate = ReturnType<typeof useT>;

function scopeLabel(t: Translate, scopeType: string): string {
  switch (scopeType) {
    case "tenant":
      return t("assignAccess.scopeTenant");
    case "legal_entity":
      return t("assignAccess.scopeLegalEntity");
    case "organization_unit":
      return t("assignAccess.scopeOrgUnit");
    case "customer":
      return t("assignAccess.scopeCustomer");
    default:
      return scopeType;
  }
}

export function AssignAccessDialog({
  targetUserId,
  targetName,
  targetEmail,
  onClose,
  onApplied,
  restoreFocusRef,
}: {
  targetUserId: string;
  targetName: string;
  targetEmail: string;
  onClose: () => void;
  onApplied: (message: string) => void;
  restoreFocusRef?: React.RefObject<HTMLElement | null>;
}) {
  const { session, logout } = useAuth();
  const t = useT();
  const token = session!.accessToken;
  const optionsState = useAssignmentOptions(true);
  const [pairs, setPairs] = useState<AdminRoleAssignmentInput[]>([]);
  const [step, setStep] = useState<Step>("edit");
  const [preview, setPreview] = useState<AdminAssignmentBatchPreview | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [acceptedIds, setAcceptedIds] = useState<string[] | null>(null);
  // A ref, not state: the confirm button can fire twice before a re-render
  // delivers the updated `pending`, and each POST is a real grant.
  const confirmInFlight = useRef(false);

  const pending = step === "previewing" || step === "pending";

  const closeDialog = useCallback(() => {
    if (pending) return;
    onClose();
  }, [onClose, pending]);

  async function requestPreview() {
    if (pending) return;
    if (pairs.length === 0) {
      setError(t("assignAccess.needPair"));
      return;
    }
    const badIndex = pairs.findIndex(
      (pair) =>
        pair.scopeType === "customer" ||
        (pair.scopeType === "tenant" &&
          optionsState.options !== null &&
          !optionsState.options.canAssignTenantScope),
    );
    if (badIndex >= 0) {
      setError(
        t("common.form.invalid", { fields: t("pairEditor.scopeLabel", { index: badIndex + 1 }) }),
      );
      return;
    }
    setStep("previewing");
    setError(null);
    try {
      const result = await api.previewAdminUserAssignments(token, targetUserId, {
        pairs,
      });
      setPreview(result);
      setStep("review");
    } catch (err) {
      setError(errorMessage(t, err, t("assignAccess.reviewFailed")));
      setStep("edit");
    }
  }

  async function verifyAcceptedBatch(createdIds: string[]) {
    const authoritative = await api.adminUserAccess(token, targetUserId);
    const present = new Set(
      authoritative.roleAssignments.map((assignment) => assignment.id),
    );
    const missing = createdIds.filter((id) => !present.has(id));
    if (missing.length > 0) {
      throw new Error(t("assignAccess.missingAssignments"));
    }
    setStep("success");
    onApplied(
      createdIds.length === 1
        ? t("assignAccess.addedOne", { name: targetName })
        : t("assignAccess.addedMany", {
            count: createdIds.length,
            name: targetName,
          }),
    );
  }

  function verificationMessage(err: unknown): string {
    if (err instanceof ApiError && err.status === 401) {
      return t("assignAccess.verifySessionExpired");
    }
    if (err instanceof ApiError && err.status === 403) {
      return t("assignAccess.verifyForbidden");
    }
    const detail =
      err instanceof Error ? err.message : t("assignAccess.verifyFailedFallback");
    return t("assignAccess.verifyFailed", { detail });
  }

  async function confirmBatch() {
    if (confirmInFlight.current || pending || !preview) return;
    confirmInFlight.current = true;
    setStep("pending");
    setError(null);
    let createdIds: string[];
    try {
      const result = await api.confirmAdminUserAssignments(token, targetUserId, {
        pairs,
        previewHash: preview.previewHash,
        confirm: true,
      });
      createdIds = result.created.map((assignment) => assignment.id);
    } catch (err) {
      if (err instanceof ApiError) {
        // The server answered: the batch was refused, nothing was written.
        setError(errorMessage(t, err, t("assignAccess.applyFailed")));
        setStep("failed");
      } else {
        // No answer arrived. The POST may have been applied, so this flow must
        // not return to an editable confirm that could apply it a second time.
        setError(t("assignAccess.unknownOutcome"));
        setStep("unknown-outcome");
      }
      return;
    } finally {
      confirmInFlight.current = false;
    }

    setAcceptedIds(createdIds);
    try {
      await verifyAcceptedBatch(createdIds);
    } catch (err) {
      setError(verificationMessage(err));
      setStep("verification-failed");
    }
  }

  async function retryVerification() {
    if (pending || !acceptedIds) return;
    setStep("pending");
    setError(null);
    try {
      await verifyAcceptedBatch(acceptedIds);
    } catch (err) {
      setError(verificationMessage(err));
      setStep("verification-failed");
    }
  }

  // Read once so the closure below narrows: a property access on state inside
  // a callback cannot rely on the `||` chain's narrowing of it.
  const options = optionsState.options;
  const reviewDisabled = options === null;

  return (
    <OverlayDialog
      open
      title={t("assignAccess.title", { name: targetName })}
      description={<span className="break-all">{targetEmail}</span>}
      pending={pending}
      onClose={closeDialog}
      restoreFocusRef={restoreFocusRef}
      size="lg"
      footer={
        step === "edit" || step === "previewing" ? (
          <>
            <Button
              variant="secondary"
              className="min-h-[44px]"
              onClick={closeDialog}
              disabled={pending}
            >
              {t("common.cancel")}
            </Button>
            <Button
              className="min-h-[44px]"
              disabled={pending || reviewDisabled}
              onClick={() => void requestPreview()}
            >
              {step === "previewing" ? t("assignAccess.reviewing") : t("assignAccess.review")}
            </Button>
          </>
        ) : step === "review" ? (
          <>
            <Button
              variant="secondary"
              className="min-h-[44px]"
              onClick={() => {
                setPreview(null);
                setStep("edit");
              }}
            >
              {t("assignAccess.back")}
            </Button>
            <Button className="min-h-[44px]" onClick={() => void confirmBatch()}>
              {(preview?.pairs.length ?? 0) === 1
                ? t("assignAccess.confirmOne")
                : t("assignAccess.confirmMany", { count: preview?.pairs.length ?? 0 })}
            </Button>
          </>
        ) : step === "failed" ? (
          <>
            <Button
              variant="secondary"
              className="min-h-[44px]"
              onClick={() => {
                setError(null);
                setStep("edit");
              }}
            >
              {t("assignAccess.back")}
            </Button>
          </>
        ) : step === "unknown-outcome" ? (
          <Button variant="secondary" className="min-h-[44px]" onClick={closeDialog}>
            {t("assignAccess.close")}
          </Button>
        ) : step === "verification-failed" ? (
          <>
            <Button
              variant="secondary"
              className="min-h-[44px]"
              onClick={closeDialog}
            >
              {t("assignAccess.close")}
            </Button>
            <Button
              className="min-h-[44px]"
              disabled={!acceptedIds}
              onClick={() => void retryVerification()}
            >
              {t("assignAccess.retryVerification")}
            </Button>
          </>
        ) : step === "pending" ? (
          <Button className="min-h-[44px]" disabled>
            {acceptedIds ? t("assignAccess.verifying") : t("assignAccess.applying")}
          </Button>
        ) : null
      }
    >
      {step === "success" && (
        <Alert tone="success">{t("assignAccess.successBody")}</Alert>
      )}

      {step === "verification-failed" && (
        <div className="space-y-4">
          <Alert tone="warning">
            <div className="space-y-1">
              <p className="font-medium">{t("assignAccess.verifyFailedTitle")}</p>
              <p>{error}</p>
              <p>{t("assignAccess.verifyFailedBody")}</p>
            </div>
          </Alert>
          {preview && <PreviewSummary preview={preview} applied />}
        </div>
      )}

      {step === "unknown-outcome" && (
        <div className="space-y-4">
          <Alert tone="warning">
            <div className="space-y-1">
              <p className="font-medium">{t("assignAccess.unknownTitle")}</p>
              <p>{error}</p>
              <p>{t("assignAccess.unknownBody")}</p>
            </div>
          </Alert>
          {preview && <PreviewSummary preview={preview} applied />}
        </div>
      )}

      {(step === "review" || step === "pending" || step === "failed") && preview && (
        <div className="space-y-5">
          {error && <Alert tone="error">{error}</Alert>}
          <PreviewSummary preview={preview} />
          {step === "pending" && (
            <Alert tone="info">
              {acceptedIds
                ? t("assignAccess.pendingVerify")
                : t("assignAccess.pendingApply")}
            </Alert>
          )}
        </div>
      )}

      {(step === "edit" || step === "previewing") && (
        <div className="space-y-4">
          {error && <Alert tone="error">{error}</Alert>}
          {optionsState.status === "loading" || optionsState.status === "idle" ? (
            <Spinner label={t("assignAccess.loadingChoices")} />
          ) : optionsState.status === "session-expired" ? (
            <Alert tone="warning">
              <div className="flex flex-wrap items-center justify-between gap-3">
                <span>{t("assignAccess.sessionExpired")}</span>
                <Button variant="secondary" onClick={logout}>
                  {t("assignAccess.signInAgain")}
                </Button>
              </div>
            </Alert>
          ) : optionsState.status === "error" || optionsState.status === "denied" ? (
            <Alert tone="error">
              <div className="flex flex-wrap items-center justify-between gap-3">
                <span>
                  {optionsState.error ?? t("assignAccess.optionsUnavailable")}
                </span>
                <Button variant="secondary" onClick={optionsState.reload}>
                  {t("assignAccess.retry")}
                </Button>
              </div>
            </Alert>
          ) : optionsState.options ? (
            <>
              <AssignmentPairEditor
                options={optionsState.options}
                pairs={pairs}
                onChange={setPairs}
                addLabel={t("pairEditor.add")}
              />
              <p className="text-sm text-ink-dim">{t("assignAccess.batchAtomic")}</p>
            </>
          ) : null}
        </div>
      )}
    </OverlayDialog>
  );
}

function PreviewSummary({
  preview,
  applied = false,
}: {
  preview: AdminAssignmentBatchPreview;
  applied?: boolean;
}) {
  const t = useT();
  return (
    <section
      aria-labelledby="batch-preview-title"
      className="rounded border border-line-strong bg-panel-2 p-4"
    >
      <h3 id="batch-preview-title" className="text-sm font-semibold text-ink">
        {applied
          ? t("assignAccess.previewAcceptedTitle")
          : t("assignAccess.previewTitle")}
      </h3>
      <ul className="mt-3 divide-y divide-line">
        {preview.pairs.map((pair) => (
          <li
            key={assignmentPairKey(pair)}
            className="flex flex-col gap-1 py-2.5 sm:flex-row sm:items-center sm:justify-between"
          >
            <div className="min-w-0">
              <div className="text-sm font-medium text-ink">{pair.roleName}</div>
              <code className="break-all font-mono text-xs text-ink-dim">
                {pair.roleCode}
              </code>
            </div>
            <div className="text-sm text-ink-dim sm:text-right">
              {scopeLabel(t, pair.scopeType)}
              {" · "}
              {pair.scopeType === "tenant"
                ? t("assignAccess.scopeTenant")
                : pair.scopeType === "legal_entity"
                  ? pair.scopeLegalEntityName ?? t("assignAccess.unknownLegalEntity")
                  : pair.scopeType === "organization_unit"
                    ? pair.scopeOrganizationUnitName ?? t("assignAccess.unknownOrgUnit")
                    : pair.scopeCustomerName ?? t("assignAccess.unknownCustomer")}
            </div>
          </li>
        ))}
      </ul>
      <p className="mt-3 break-all font-mono text-[11.5px] text-ink-faint">
        {preview.previewHash}
      </p>
      <p className="mt-1 text-xs text-ink-faint">{t("assignAccess.hashNote")}</p>
    </section>
  );
}
