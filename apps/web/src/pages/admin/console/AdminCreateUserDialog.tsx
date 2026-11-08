/**
 * Epic 4 Wave 2 §4.4 step 11 — governed Create User.
 *
 * One confirmation creates the User together with an optional initial
 * assignment set. `pairs` defaults to empty on the server, so an account with
 * no assignment is valid and has no effective access; the browser never
 * fabricates one. Status is not settable here: the browser has no say in it,
 * and the account starts from the server's governed default.
 *
 * The initial pairs reuse the batch preview/confirm surface via
 * AssignmentPairEditor only as a choice editor — the create call itself is
 * one POST /admin/users whose in-transaction pair policy is the same one the
 * batch surface runs (§4.4 D).
 */
import { useCallback, useRef, useState } from "react";
import { useAuth } from "../../../auth/AuthContext";
import { useT } from "../../../i18n/LocaleProvider";
import { api, type AdminRoleAssignmentInput } from "../../../lib/api";
import { Alert, Button, Field, Input } from "../../../shell/components/ui";
import { OverlayDialog } from "../../../shell/components/OverlayDialog";
import {
  AssignmentPairEditor,
  assignmentPairsHaveDuplicate,
  errorMessage,
  useAssignmentOptions,
} from "./AdminAssignmentControls";

type Step = "edit" | "pending" | "success";

export function AdminCreateUserDialog({
  onClose,
  onCreated,
  restoreFocusRef,
}: {
  onClose: () => void;
  onCreated: (message: string) => void;
  restoreFocusRef?: React.RefObject<HTMLElement | null>;
}) {
  const { session } = useAuth();
  const t = useT();
  const token = session!.accessToken;
  const formRef = useRef<HTMLFormElement>(null);
  const [step, setStep] = useState<Step>("edit");
  const [error, setError] = useState<string | null>(null);
  const [showPairs, setShowPairs] = useState(false);
  const [pairs, setPairs] = useState<AdminRoleAssignmentInput[]>([]);
  // The governed choices are fetched only when the operator opts in, not on
  // every dialog open.
  const optionsState = useAssignmentOptions(showPairs);
  // A ref, not state: the create button can fire twice before a re-render
  // delivers the updated `pending`, and each POST creates a real user.
  const submitInFlight = useRef(false);

  const pending = step === "pending";

  const closeDialog = useCallback(() => {
    if (pending) return;
    onClose();
  }, [onClose, pending]);

  async function submit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (submitInFlight.current || pending || !formRef.current) return;
    const form = new FormData(formRef.current);
    const email = String(form.get("email") ?? "").trim();
    const fullName = String(form.get("fullName") ?? "").trim();
    const password = String(form.get("password") ?? "");

    if (email.length === 0 || fullName.length === 0 || password.length < 8) {
      setError(t("adminCreateUser.missingFields"));
      return;
    }
    if (showPairs && assignmentPairsHaveDuplicate(pairs)) {
      setError(t("adminCreateUser.duplicatePair"));
      return;
    }

    // Latch only once validation has passed: an early return above must not
    // leave it set, or every later submit is silently ignored.
    submitInFlight.current = true;
    setStep("pending");
    setError(null);
    try {
      const result = await api.createAdminUser(token, {
        email,
        fullName,
        password,
        pairs: showPairs ? pairs : [],
      });
      setStep("success");
      onCreated(
        pairs.length > 0
          ? result.assignments.length === 1
            ? t("adminCreateUser.createdWithOnePair", { name: result.user.fullName })
            : t("adminCreateUser.createdWithPairs", {
                name: result.user.fullName,
                count: result.assignments.length,
              })
          : t("adminCreateUser.createdWithoutPairs", { name: result.user.fullName }),
      );
    } catch (err) {
      setError(errorMessage(t, err, t("adminCreateUser.createFailed")));
      setStep("edit");
    } finally {
      submitInFlight.current = false;
    }
  }

  return (
    <OverlayDialog
      open
      title={t("adminCreateUser.title")}
      description={t("adminCreateUser.description")}
      pending={pending}
      onClose={closeDialog}
      restoreFocusRef={restoreFocusRef}
      size="lg"
      footer={
        step === "success" ? (
          <Button className="min-h-[44px]" onClick={closeDialog}>
            {t("adminCreateUser.done")}
          </Button>
        ) : (
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
              disabled={pending}
              onClick={() => formRef.current?.requestSubmit()}
            >
              {pending ? t("adminCreateUser.submitting") : t("adminCreateUser.submit")}
            </Button>
          </>
        )
      }
    >
      {step === "success" ? (
        <Alert tone="success">{t("adminCreateUser.success")}</Alert>
      ) : (
        <form ref={formRef} onSubmit={submit} className="space-y-5">
          {error && <Alert tone="error">{error}</Alert>}
          <div className="grid gap-4 sm:grid-cols-2">
            <Field label={t("adminCreateUser.email")} required>
              <Input
                name="email"
                type="email"
                required
                maxLength={255}
                autoComplete="off"
                disabled={pending}
              />
            </Field>
            <Field label={t("adminCreateUser.fullName")} required>
              <Input
                name="fullName"
                required
                minLength={1}
                maxLength={200}
                autoComplete="off"
                disabled={pending}
              />
            </Field>
          </div>
          <Field
            label={t("adminCreateUser.password")}
            required
            hint={t("adminCreateUser.passwordHint")}
          >
            <Input
              name="password"
              type="password"
              required
              minLength={8}
              autoComplete="new-password"
              disabled={pending}
            />
          </Field>

          <div className="border-t border-line pt-4">
            {showPairs ? (
              <div className="space-y-4">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <h3 className="text-sm font-semibold text-ink">
                    {t("adminCreateUser.initialTitle")}
                  </h3>
                  <Button
                    variant="ghost"
                    onClick={() => {
                      setPairs([]);
                      setShowPairs(false);
                    }}
                    disabled={pending}
                  >
                    {t("adminCreateUser.removeInitial")}
                  </Button>
                </div>
                {optionsState.status === "loading" || optionsState.status === "idle" ? (
                  <p className="text-sm text-ink-dim">{t("adminCreateUser.loadingOptions")}</p>
                ) : optionsState.options ? (
                  <AssignmentPairEditor
                    options={optionsState.options}
                    pairs={pairs}
                    onChange={setPairs}
                    addLabel={t("adminCreateUser.addInitialRow")}
                  />
                ) : (
                  <Alert tone="warning">{t("adminCreateUser.optionsFailed")}</Alert>
                )}
              </div>
            ) : (
              <Button
                variant="secondary"
                disabled={pending}
                onClick={() => setShowPairs(true)}
              >
                {t("adminCreateUser.addInitial")}
              </Button>
            )}
          </div>
          <p className="text-sm text-ink-dim">{t("adminCreateUser.statusNote")}</p>
        </form>
      )}
    </OverlayDialog>
  );
}
