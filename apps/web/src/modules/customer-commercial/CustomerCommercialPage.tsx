/** Phase 10 — Customer & Commercial completion (CUS.4). */
import { useT } from "../../i18n/LocaleProvider";
import { useCallback, useEffect, useMemo, useState, type FormEvent, type ReactNode } from "react";
import { useAuth } from "../../auth/AuthContext";
import {
  api,
  ApiError,
  type CommercialService,
  type ContractRecord,
  type Customer,
  type CustomerContact,
  type CustomerServiceLink,
  type ProjectRecord,
  type SiteRecord,
} from "../../lib/api";
import {
  Alert,
  Button,
  Card,
  DataTable,
  EmptyState,
  Field,
  Input,
  PageHeader,
  Select,
  Spinner,
  StatusPill,
  Textarea,
  type Column,
} from "../../shell/components/ui";

type OrgUnit = { id: string; parentId: string | null; name: string; unitType: string; legalEntityId: string };

type DetailState = {
  contacts: CustomerContact[];
  contracts: ContractRecord[];
  projects: ProjectRecord[];
  sites: SiteRecord[];
  links: CustomerServiceLink[];
};

const emptyDetail: DetailState = {
  contacts: [],
  contracts: [],
  projects: [],
  sites: [],
  links: [],
};

function statusTone(status: string): "neutral" | "info" | "success" | "warning" | "danger" {
  const normalized = status.toLowerCase();
  if (["active", "current", "open"].includes(normalized)) return "success";
  if (["inactive", "ended", "cancelled", "terminated"].includes(normalized)) return "danger";
  if (["draft", "planned", "pending"].includes(normalized)) return "warning";
  return "info";
}

function nullableValue(value: FormDataEntryValue | null): string | null {
  const text = String(value ?? "").trim();
  return text ? text : null;
}

function optionalValue(value: FormDataEntryValue | null): string | undefined {
  const text = String(value ?? "").trim();
  return text ? text : undefined;
}

function maintenanceStatus(status: string): { label: string; next: string } {
  return status.toLowerCase() === "active"
    ? { label: "Deactivate", next: "inactive" }
    : { label: "Reactivate", next: "active" };
}

export function CustomerCommercialPage() {
  const t = useT();
  const { session } = useAuth();
  const token = session!.accessToken;

  const [permissions, setPermissions] = useState<string[]>([]);
  const [customers, setCustomers] = useState<Customer[]>([]);
  const [services, setServices] = useState<CommercialService[]>([]);
  const [orgUnits, setOrgUnits] = useState<OrgUnit[]>([]);
  const [selectedCustomerId, setSelectedCustomerId] = useState("");
  const [detail, setDetail] = useState<DetailState>(emptyDetail);
  const [loading, setLoading] = useState(true);
  const [detailLoading, setDetailLoading] = useState(false);
  const [message, setMessage] = useState<{ type: "error" | "success" | "info"; text: string } | null>(null);

  const selectedCustomer = useMemo(
    () => customers.find((customer) => customer.id === selectedCustomerId) ?? null,
    [customers, selectedCustomerId],
  );

  const canReadContract = permissions.includes("contract.read") || permissions.includes("contract.manage");
  const canReadProject = permissions.includes("project.read") || permissions.includes("project.manage");
  const canReadSite = permissions.includes("site.read") || permissions.includes("site.manage");
  const canReadService = permissions.includes("service.read") || permissions.includes("service.manage");
  const canManageCustomer = permissions.includes("customer.manage");
  const canManageContract = permissions.includes("contract.manage");
  const canManageProject = permissions.includes("project.manage");
  const canManageSite = permissions.includes("site.manage");
  const canManageService = permissions.includes("service.manage");

  const loadDetail = useCallback(
    async (customerId: string, currentPermissions: string[]) => {
      if (!customerId) {
        setDetail(emptyDetail);
        return;
      }
      setDetailLoading(true);
      try {
        const [contacts, contracts, projects, sites, links] = await Promise.all([
          api.customerContacts(token, customerId),
          currentPermissions.includes("contract.read") || currentPermissions.includes("contract.manage")
            ? api.contracts(token, customerId)
            : Promise.resolve([]),
          currentPermissions.includes("project.read") || currentPermissions.includes("project.manage")
            ? api.projectsForCustomer(token, customerId)
            : Promise.resolve([]),
          currentPermissions.includes("site.read") || currentPermissions.includes("site.manage")
            ? api.sitesForCustomer(token, customerId)
            : Promise.resolve([]),
          currentPermissions.includes("service.read") || currentPermissions.includes("service.manage")
            ? api.customerServiceLinks(token, customerId)
            : Promise.resolve([]),
        ]);
        setDetail({ contacts, contracts, projects, sites, links });
      } catch (err) {
        setMessage({
          type: "error",
          text: err instanceof ApiError ? err.message : t("cc.main.msg.couldNotLoadCustomerCommercialDetail"),
        });
      } finally {
        setDetailLoading(false);
      }
    },
    [token, t],
  );

  const load = useCallback(async () => {
    setLoading(true);
    setMessage(null);
    try {
      const me = await api.me(token);
      setPermissions(me.permissions);
      const [customerList, serviceList, unitList] = await Promise.all([
        api.customers(token),
        me.permissions.includes("service.read") || me.permissions.includes("service.manage")
          ? api.commercialServices(token)
          : Promise.resolve([]),
        api.organizationUnits(token).catch(() => []),
      ]);
      setCustomers(customerList);
      setServices(serviceList);
      const nextCustomerId = customerList.some((customer) => customer.id === selectedCustomerId)
        ? selectedCustomerId
        : (customerList[0]?.id ?? "");
      setSelectedCustomerId(nextCustomerId);
      setOrgUnits(unitList);
      await loadDetail(nextCustomerId, me.permissions);
    } catch (err) {
      setMessage({ type: "error", text: err instanceof ApiError ? err.message : t("cc.main.msg.couldNotLoadCustomers") });
    } finally {
      setLoading(false);
    }
  }, [loadDetail, selectedCustomerId, token, t]);

  useEffect(() => {
    void load();
  }, [load]);

  async function reloadSelected(successText: string) {
    setMessage({ type: "success", text: successText });
    const [customerList, serviceList] = await Promise.all([
      api.customers(token),
      canReadService ? api.commercialServices(token) : Promise.resolve([]),
    ]);
    setCustomers(customerList);
    setServices(serviceList);
    const nextCustomerId = customerList.some((customer) => customer.id === selectedCustomerId)
      ? selectedCustomerId
      : (customerList[0]?.id ?? "");
    setSelectedCustomerId(nextCustomerId);
    await loadDetail(nextCustomerId, permissions);
  }

  async function handleCustomerChange(customerId: string) {
    setSelectedCustomerId(customerId);
    setMessage(null);
    await loadDetail(customerId, permissions);
  }

  async function submitForm(e: FormEvent<HTMLFormElement>, action: (form: FormData) => Promise<void>) {
    e.preventDefault();
    // React clears currentTarget once the handler yields, so keep the form
    // before awaiting; reset() after the await used to throw on success.
    const form = e.currentTarget;
    try {
      await action(new FormData(form));
      form.reset();
    } catch (err) {
      setMessage({ type: "error", text: err instanceof ApiError ? err.message : t("cc.main.msg.requestFailed") });
    }
  }

  const customerColumns: Column<Customer>[] = [
    { header: t("cc.main.h.customer"), cell: (row) => <span className="font-medium">{row.name}</span> },
    { header: t("cc.main.h.code"), cell: (row) => row.code },
    { header: t("cc.main.h.ownerOu"), cell: (row) => orgUnits.find((unit) => unit.id === row.ownerOrganizationUnitId)?.name ?? "—" },
    { header: t("cc.main.h.status"), cell: (row) => <StatusPill tone={statusTone(row.status)}>{row.status}</StatusPill> },
    ...(canManageCustomer
      ? [
          {
            header: t("cc.main.h.actions"),
            cell: (row) => {
              const transition = maintenanceStatus(row.status);
              return (
                <Button
                  type="button"
                  variant="secondary"
                  onClick={(event) => {
                    event.stopPropagation();
                    void api
                      .updateCustomer(token, row.id, { status: transition.next })
                      .then(() => reloadSelected(`Customer ${transition.next === "active" ? "reactivated" : "deactivated"}.`))
                      .catch((err) => setMessage({ type: "error", text: err instanceof ApiError ? err.message : t("cc.main.msg.statusUpdateFailed") }));
                  }}
                >
                  {transition.label}
                </Button>
              );
            },
          } satisfies Column<Customer>,
        ]
      : []),
  ];

  const contactColumns: Column<CustomerContact>[] = [
    { header: t("cc.main.h.name"), cell: (row) => <span className="font-medium">{row.name}</span> },
    { header: t("cc.main.h.email"), cell: (row) => row.email ?? "—" },
    { header: t("cc.main.h.phone"), cell: (row) => row.phone ?? "—" },
    { header: t("cc.main.h.primary"), cell: (row) => (row.isPrimary ? <StatusPill tone="success">{t("cc.main.t.primary")}</StatusPill> : "—") },
    ...(canManageCustomer
      ? [
          {
            header: t("cc.main.h.actions"),
            cell: (row) => (
              <Button
                type="button"
                variant="secondary"
                onClick={(event) => {
                  event.stopPropagation();
                  void api
                    .updateCustomerContact(token, row.id, { isPrimary: !row.isPrimary })
                    .then(() => reloadSelected("Contact updated."))
                    .catch((err) => setMessage({ type: "error", text: err instanceof ApiError ? err.message : t("cc.main.msg.contactUpdateFailed") }));
                }}
              >
                {row.isPrimary ? "Unset primary" : "Set primary"}
              </Button>
            ),
          } satisfies Column<CustomerContact>,
        ]
      : []),
  ];

  const contractColumns: Column<ContractRecord>[] = [
    { header: t("cc.main.h.contract"), cell: (row) => <span className="font-medium">{row.name}</span> },
    { header: t("cc.main.h.code"), cell: (row) => row.code },
    { header: t("cc.main.h.period"), cell: (row) => `${row.startDate ?? "—"} → ${row.endDate ?? "—"}` },
    { header: t("cc.main.h.status"), cell: (row) => <StatusPill tone={statusTone(row.status)}>{row.status}</StatusPill> },
    ...(canManageContract
      ? [
          {
            header: t("cc.main.h.actions"),
            cell: (row) => {
              const transition = maintenanceStatus(row.status);
              return (
                <Button
                  type="button"
                  variant="secondary"
                  onClick={() =>
                    void api
                      .updateContract(token, row.id, { status: transition.next })
                      .then(() => reloadSelected(`Contract ${transition.next === "active" ? "reactivated" : "deactivated"}.`))
                      .catch((err) => setMessage({ type: "error", text: err instanceof ApiError ? err.message : t("cc.main.msg.contractUpdateFailed") }))
                  }
                >
                  {transition.label}
                </Button>
              );
            },
          } satisfies Column<ContractRecord>,
        ]
      : []),
  ];

  const projectColumns: Column<ProjectRecord>[] = [
    { header: t("cc.main.h.project"), cell: (row) => <span className="font-medium">{row.name}</span> },
    { header: t("cc.main.h.code"), cell: (row) => row.code },
    { header: t("cc.main.h.contract"), cell: (row) => detail.contracts.find((contract) => contract.id === row.contractId)?.code ?? "—" },
    { header: t("cc.main.h.status"), cell: (row) => <StatusPill tone={statusTone(row.status)}>{row.status}</StatusPill> },
    ...(canManageProject
      ? [
          {
            header: t("cc.main.h.actions"),
            cell: (row) => {
              const transition = maintenanceStatus(row.status);
              return (
                <Button
                  type="button"
                  variant="secondary"
                  onClick={() =>
                    void api
                      .updateProject(token, row.id, { status: transition.next })
                      .then(() => reloadSelected(`Project ${transition.next === "active" ? "reactivated" : "deactivated"}.`))
                      .catch((err) => setMessage({ type: "error", text: err instanceof ApiError ? err.message : t("cc.main.msg.projectUpdateFailed") }))
                  }
                >
                  {transition.label}
                </Button>
              );
            },
          } satisfies Column<ProjectRecord>,
        ]
      : []),
  ];

  const siteColumns: Column<SiteRecord>[] = [
    { header: t("cc.main.h.siteLocation"), cell: (row) => <span className="font-medium">{row.name}</span> },
    { header: t("cc.main.h.code"), cell: (row) => row.code },
    { header: t("cc.main.h.project"), cell: (row) => detail.projects.find((project) => project.id === row.projectId)?.code ?? "—" },
    { header: t("cc.main.h.address"), cell: (row) => row.address ?? "—" },
    { header: t("cc.main.h.status"), cell: (row) => <StatusPill tone={statusTone(row.status)}>{row.status}</StatusPill> },
    ...(canManageSite
      ? [
          {
            header: t("cc.main.h.actions"),
            cell: (row) => {
              const transition = maintenanceStatus(row.status);
              return (
                <Button
                  type="button"
                  variant="secondary"
                  onClick={() =>
                    void api
                      .updateSite(token, row.id, { status: transition.next })
                      .then(() => reloadSelected(`Site ${transition.next === "active" ? "reactivated" : "deactivated"}.`))
                      .catch((err) => setMessage({ type: "error", text: err instanceof ApiError ? err.message : t("cc.main.msg.siteUpdateFailed") }))
                  }
                >
                  {transition.label}
                </Button>
              );
            },
          } satisfies Column<SiteRecord>,
        ]
      : []),
  ];

  const serviceColumns: Column<CommercialService>[] = [
    { header: t("cc.main.h.service"), cell: (row) => <span className="font-medium">{row.name}</span> },
    { header: t("cc.main.h.code"), cell: (row) => row.code },
    { header: t("cc.main.h.description"), cell: (row) => row.description ?? "—" },
    { header: t("cc.main.h.active"), cell: (row) => <StatusPill tone={row.isActive ? "success" : "danger"}>{row.isActive ? "Active" : "Inactive"}</StatusPill> },
    ...(canManageService
      ? [
          {
            header: t("cc.main.h.actions"),
            cell: (row) => (
              <Button
                type="button"
                variant="secondary"
                onClick={() =>
                  void api
                    .updateCommercialService(token, row.id, { isActive: !row.isActive })
                    .then(() => reloadSelected(`Service ${row.isActive ? "deactivated" : "reactivated"}.`))
                    .catch((err) => setMessage({ type: "error", text: err instanceof ApiError ? err.message : t("cc.main.msg.serviceUpdateFailed") }))
                }
              >
                {row.isActive ? "Deactivate" : "Reactivate"}
              </Button>
            ),
          } satisfies Column<CommercialService>,
        ]
      : []),
  ];

  const linkColumns: Column<CustomerServiceLink>[] = [
    { header: t("cc.main.h.service"), cell: (row) => services.find((service) => service.id === row.serviceId)?.name ?? row.serviceId.slice(0, 8) },
    { header: t("cc.main.h.contract"), cell: (row) => detail.contracts.find((contract) => contract.id === row.contractId)?.code ?? "—" },
    { header: t("cc.main.h.project"), cell: (row) => detail.projects.find((project) => project.id === row.projectId)?.code ?? "—" },
    { header: t("cc.main.h.site"), cell: (row) => detail.sites.find((site) => site.id === row.siteId)?.code ?? "—" },
    { header: t("cc.main.h.status"), cell: (row) => <StatusPill tone={statusTone(row.status)}>{row.status}</StatusPill> },
    ...(canManageService
      ? [
          {
            header: t("cc.main.h.actions"),
            cell: (row) => {
              const transition = maintenanceStatus(row.status);
              return (
                <Button
                  type="button"
                  variant="secondary"
                  onClick={() =>
                    void api
                      .updateCustomerServiceLink(token, row.id, { status: transition.next })
                      .then(() => reloadSelected(`Service link ${transition.next === "active" ? "reactivated" : "deactivated"}.`))
                      .catch((err) => setMessage({ type: "error", text: err instanceof ApiError ? err.message : t("cc.main.msg.serviceLinkUpdateFailed") }))
                  }
                >
                  {transition.label}
                </Button>
              );
            },
          } satisfies Column<CustomerServiceLink>,
        ]
      : []),
  ];

  return (
    <div className="space-y-6">
      <PageHeader
        title={t("cc.main.title.customerCommercial")}
        subtitle={t("cc.main.sub.manageCustomersContactsContractsProjects")}
        actions={<Button onClick={load}>{t("cc.main.t.refresh")}</Button>}
      />

      {message ? <Alert tone={message.type}>{message.text}</Alert> : null}

      <Card>
        <p className="text-sm text-slate-600">
          Create, update, and deactivate/reactivate maintenance uses Customer & Commercial backend endpoints with tenant isolation, RBAC, Customer Data Scope, audit logging, and no hard-delete behavior enforced server-side.
        </p>
      </Card>

      {loading ? (
        <Spinner />
      ) : (
        <>
          <div className="grid grid-cols-1 gap-6 xl:grid-cols-[minmax(0,1.1fr)_minmax(360px,0.9fr)]">
            <Card className="space-y-4">
              <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
                <div>
                  <h2 className="text-sm font-semibold text-slate-900">{t("cc.main.t.customers")}</h2>
                  <p className="text-sm text-slate-500">{t("cc.main.n.rowsAreAlreadyLimitedToTheCallerSCustome")}</p>
                </div>
                <Select value={selectedCustomerId} onChange={(event) => void handleCustomerChange(event.target.value)} className="sm:max-w-xs">
                  <option value="">{t("cc.main.t.selectCustomer")}</option>
                  {customers.map((customer) => (
                    <option key={customer.id} value={customer.id}>
                      {customer.code} — {customer.name}
                    </option>
                  ))}
                </Select>
              </div>
              <DataTable
                columns={customerColumns}
                rows={customers}
                keyOf={(row) => row.id}
                onRowClick={(row) => void handleCustomerChange(row.id)}
                empty={<EmptyState title={t("cc.main.title.noCustomersYet")} description={t("cc.main.d.createTheFirstCustomerFromTheFormOnThisP")} />}
              />
            </Card>

            <Card>
              <h2 className="mb-3 text-sm font-semibold text-slate-900">{t("cc.main.t.createCustomer")}</h2>
              {canManageCustomer ? (
                <form
                  className="space-y-3"
                  onSubmit={(event) =>
                    void submitForm(event, async (form) => {
                      await api.createCustomer(token, {
                        code: String(form.get("code")).trim(),
                        name: String(form.get("name")).trim(),
                        status: optionalValue(form.get("status")),
                        ownerOrganizationUnitId: nullableValue(form.get("ownerOrganizationUnitId")),
                        notes: nullableValue(form.get("notes")),
                      });
                      await reloadSelected("Customer created.");
                    })
                  }
                >
                  <Field label={t("cc.main.f.code")} required><Input name="code" required /></Field>
                  <Field label={t("cc.main.f.name")} required><Input name="name" required /></Field>
                  <Field label={t("cc.main.f.status")}><Input name="status" placeholder={t("cc.main.p.active")} /></Field>
                  <Field label={t("cc.main.f.owningOrganizationUnit")}>
                    <Select name="ownerOrganizationUnitId">
                      <option value="">{t("cc.main.t.none")}</option>
                      {orgUnits.map((unit) => <option key={unit.id} value={unit.id}>{unit.name}</option>)}
                    </Select>
                  </Field>
                  <Field label={t("cc.main.f.notes")}><Textarea name="notes" rows={3} /></Field>
                  <Button type="submit">{t("cc.main.t.createCustomer")}</Button>
                </form>
              ) : (
                <p className="text-sm text-slate-500">{t("cc.main.n.youNeedCustomerManageToCreateCustomers")}</p>
              )}
            </Card>
          </div>

          {selectedCustomer ? (
            <div className="grid grid-cols-1 gap-6 xl:grid-cols-2">
              <RecordSection
                title={t("cc.main.title.contacts")}
                description={`Contacts for ${selectedCustomer.name}.`}
                loading={detailLoading}
                table={
                  <DataTable
                    columns={contactColumns}
                    rows={detail.contacts}
                    keyOf={(row) => row.id}
                    empty={<EmptyState title={t("cc.main.title.noContactsYet")} description={t("cc.main.d.addTheFirstContactForThisCustomer")} />}
                  />
                }
                form={
                  canManageCustomer ? (
                    <form
                      className="space-y-3"
                      onSubmit={(event) =>
                        void submitForm(event, async (form) => {
                          await api.createCustomerContact(token, {
                            customerId: selectedCustomer.id,
                            name: String(form.get("name")).trim(),
                            email: nullableValue(form.get("email")),
                            phone: nullableValue(form.get("phone")),
                            isPrimary: form.get("isPrimary") === "on",
                          });
                          await reloadSelected("Contact created.");
                        })
                      }
                    >
                      <Field label={t("cc.main.f.name")} required><Input name="name" required /></Field>
                      <Field label={t("cc.main.f.email")}><Input name="email" type="email" /></Field>
                      <Field label={t("cc.main.f.phone")}><Input name="phone" /></Field>
                      <label className="flex items-center gap-2 text-sm text-slate-700"><input name="isPrimary" type="checkbox" /> Primary contact</label>
                      <Button type="submit">{t("cc.main.t.addContact")}</Button>
                    </form>
                  ) : null
                }
              />

              {canReadContract ? (
                <RecordSection
                  title={t("cc.main.title.contracts")}
                  description={t("cc.main.d.commercialAgreementsBelongingToTheSelect")}
                  loading={detailLoading}
                  table={
                    <DataTable
                      columns={contractColumns}
                      rows={detail.contracts}
                      keyOf={(row) => row.id}
                      empty={<EmptyState title={t("cc.main.title.noContractsYet")} description={t("cc.main.d.createAContractForThisCustomer")} />}
                    />
                  }
                  form={
                    canManageContract ? (
                    <form
                      className="space-y-3"
                      onSubmit={(event) =>
                        void submitForm(event, async (form) => {
                          await api.createContract(token, {
                            customerId: selectedCustomer.id,
                            code: String(form.get("code")).trim(),
                            name: String(form.get("name")).trim(),
                            startDate: nullableValue(form.get("startDate")),
                            endDate: nullableValue(form.get("endDate")),
                            status: optionalValue(form.get("status")),
                          });
                          await reloadSelected("Contract created.");
                        })
                      }
                    >
                      <Field label={t("cc.main.f.code")} required><Input name="code" required /></Field>
                      <Field label={t("cc.main.f.name")} required><Input name="name" required /></Field>
                      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                        <Field label={t("cc.main.f.startDate")}><Input name="startDate" type="date" /></Field>
                        <Field label={t("cc.main.f.endDate")}><Input name="endDate" type="date" /></Field>
                      </div>
                      <Field label={t("cc.main.f.status")}><Input name="status" placeholder={t("cc.main.p.active")} /></Field>
                      <Button type="submit">{t("cc.main.t.createContract")}</Button>
                    </form>
                    ) : null
                  }
                />
              ) : null}

              {canReadProject ? (
                <RecordSection
                  title={t("cc.main.title.projects")}
                description={t("cc.main.d.projectMasterRecordsForDownstreamOperati")}
                loading={detailLoading}
                table={
                  <DataTable
                    columns={projectColumns}
                    rows={detail.projects}
                    keyOf={(row) => row.id}
                    empty={<EmptyState title={t("cc.main.title.noProjectsYet")} description={t("cc.main.d.createAProjectUnderThisCustomer")} />}
                  />
                }
                form={
                  canManageProject ? (
                    <form
                      className="space-y-3"
                      onSubmit={(event) =>
                        void submitForm(event, async (form) => {
                          await api.createProject(token, {
                            customerId: selectedCustomer.id,
                            contractId: nullableValue(form.get("contractId")),
                            code: String(form.get("code")).trim(),
                            name: String(form.get("name")).trim(),
                            status: optionalValue(form.get("status")),
                          });
                          await reloadSelected("Project created.");
                        })
                      }
                    >
                      <Field label={t("cc.main.f.code")} required><Input name="code" required /></Field>
                      <Field label={t("cc.main.f.name")} required><Input name="name" required /></Field>
                      <Field label={t("cc.main.f.contract")}>
                        <Select name="contractId">
                          <option value="">{t("cc.main.t.none")}</option>
                          {detail.contracts.map((contract) => <option key={contract.id} value={contract.id}>{contract.code} — {contract.name}</option>)}
                        </Select>
                      </Field>
                      <Field label={t("cc.main.f.status")}><Input name="status" placeholder={t("cc.main.p.active")} /></Field>
                      <Button type="submit">{t("cc.main.t.createProject")}</Button>
                    </form>
                  ) : null
                }
                />
              ) : null}

              {canReadSite ? (
                <RecordSection
                  title={t("cc.main.title.sitesLocations")}
                description={t("cc.main.d.operationalLocationsUnderTheSelectedCust")}
                loading={detailLoading}
                table={
                  <DataTable
                    columns={siteColumns}
                    rows={detail.sites}
                    keyOf={(row) => row.id}
                    empty={<EmptyState title={t("cc.main.title.noSitesYet")} description={t("cc.main.d.createASiteLocationForThisCustomer")} />}
                  />
                }
                form={
                  canManageSite ? (
                    <form
                      className="space-y-3"
                      onSubmit={(event) =>
                        void submitForm(event, async (form) => {
                          await api.createSite(token, {
                            customerId: selectedCustomer.id,
                            projectId: nullableValue(form.get("projectId")),
                            code: String(form.get("code")).trim(),
                            name: String(form.get("name")).trim(),
                            address: nullableValue(form.get("address")),
                            status: optionalValue(form.get("status")),
                          });
                          await reloadSelected("Site/location created.");
                        })
                      }
                    >
                      <Field label={t("cc.main.f.code")} required><Input name="code" required /></Field>
                      <Field label={t("cc.main.f.name")} required><Input name="name" required /></Field>
                      <Field label={t("cc.main.f.project")}>
                        <Select name="projectId">
                          <option value="">{t("cc.main.t.none")}</option>
                          {detail.projects.map((project) => <option key={project.id} value={project.id}>{project.code} — {project.name}</option>)}
                        </Select>
                      </Field>
                      <Field label={t("cc.main.f.address")}><Textarea name="address" rows={2} /></Field>
                      <Field label={t("cc.main.f.status")}><Input name="status" placeholder={t("cc.main.p.active")} /></Field>
                      <Button type="submit">{t("cc.main.t.createSite")}</Button>
                    </form>
                  ) : null
                }
                />
              ) : null}

              {canReadService ? (
                <RecordSection
                  title={t("cc.main.title.serviceCatalog")}
                description={t("cc.main.d.reusableCommercialServicesThatCanBeLinke")}
                loading={false}
                table={
                  <DataTable
                    columns={serviceColumns}
                    rows={services}
                    keyOf={(row) => row.id}
                    empty={<EmptyState title={t("cc.main.title.noServicesYet")} description={t("cc.main.d.createTheFirstServiceCatalogEntry")} />}
                  />
                }
                form={
                  canManageService ? (
                    <form
                      className="space-y-3"
                      onSubmit={(event) =>
                        void submitForm(event, async (form) => {
                          await api.createCommercialService(token, {
                            code: String(form.get("code")).trim(),
                            name: String(form.get("name")).trim(),
                            description: nullableValue(form.get("description")),
                          });
                          await reloadSelected("Service catalog entry created.");
                        })
                      }
                    >
                      <Field label={t("cc.main.f.code")} required><Input name="code" required /></Field>
                      <Field label={t("cc.main.f.name")} required><Input name="name" required /></Field>
                      <Field label={t("cc.main.f.description")}><Textarea name="description" rows={3} /></Field>
                      <Button type="submit">{t("cc.main.t.createService")}</Button>
                    </form>
                  ) : null
                }
                />
              ) : null}

              {canReadService ? (
                <RecordSection
                  title={t("cc.main.title.customerServiceLinks")}
                description={t("cc.main.d.connectServicesToThisCustomerOptionallyS")}
                loading={detailLoading}
                table={
                  <DataTable
                    columns={linkColumns}
                    rows={detail.links}
                    keyOf={(row) => row.id}
                    empty={<EmptyState title={t("cc.main.title.noServiceLinksYet")} description={t("cc.main.d.linkAServiceToThisCustomer")} />}
                  />
                }
                form={
                  canManageService ? (
                    <form
                      className="space-y-3"
                      onSubmit={(event) =>
                        void submitForm(event, async (form) => {
                          await api.createCustomerServiceLink(token, {
                            customerId: selectedCustomer.id,
                            serviceId: String(form.get("serviceId")),
                            contractId: nullableValue(form.get("contractId")),
                            projectId: nullableValue(form.get("projectId")),
                            siteId: nullableValue(form.get("siteId")),
                            internalPicUserId: nullableValue(form.get("internalPicUserId")),
                          });
                          await reloadSelected("Customer-service link created.");
                        })
                      }
                    >
                      <Field label={t("cc.main.f.service")} required>
                        <Select name="serviceId" required>
                          <option value="">{t("cc.main.t.selectService")}</option>
                          {services.map((service) => <option key={service.id} value={service.id}>{service.code} — {service.name}</option>)}
                        </Select>
                      </Field>
                      <Field label={t("cc.main.f.contract")}>
                        <Select name="contractId"><option value="">{t("cc.main.t.none")}</option>{detail.contracts.map((contract) => <option key={contract.id} value={contract.id}>{contract.code}</option>)}</Select>
                      </Field>
                      <Field label={t("cc.main.f.project")}>
                        <Select name="projectId"><option value="">{t("cc.main.t.none")}</option>{detail.projects.map((project) => <option key={project.id} value={project.id}>{project.code}</option>)}</Select>
                      </Field>
                      <Field label={t("cc.main.f.siteLocation")}>
                        <Select name="siteId"><option value="">{t("cc.main.t.none")}</option>{detail.sites.map((site) => <option key={site.id} value={site.id}>{site.code}</option>)}</Select>
                      </Field>
                      <Field label={t("cc.main.f.internalPicUserId")}><Input name="internalPicUserId" placeholder={t("cc.main.p.optionalUuid")} /></Field>
                      <Button type="submit">{t("cc.main.t.linkService")}</Button>
                    </form>
                  ) : null
                }
                />
              ) : null}
            </div>
          ) : null}
        </>
      )}
    </div>
  );
}

function RecordSection({
  title,
  description,
  loading,
  table,
  form,
}: {
  title: string;
  description: string;
  loading: boolean;
  table: ReactNode;
  form?: ReactNode;
}) {
  return (
    <Card className="space-y-4">
      <div>
        <h2 className="text-sm font-semibold text-slate-900">{title}</h2>
        <p className="text-sm text-slate-500">{description}</p>
      </div>
      {loading ? <Spinner /> : table}
      {form ? <div className="border-t border-slate-100 pt-4">{form}</div> : null}
    </Card>
  );
}
