import { Routes, usePathname, type RouteDef } from './lib/router';
import { ErrorBoundary } from './components/ErrorBoundary';
import { DashboardPage } from './pages/Dashboard';
import { MyTasksPage } from './pages/MyTasks';
import { CompanyDetailPage } from './pages/CompanyDetail';
import { DealDetailPage } from './pages/DealDetail';
import { CrmPage } from './pages/Crm';
import { ProjectsPage } from './pages/Projects';
import { ProjectDetailPage } from './pages/ProjectDetail';
import { TaskPage } from './pages/TaskPage';
import { KbPage } from './pages/Kb';
import { TimePage } from './pages/Time';
import { FinancePage } from './pages/Finance';
import { InvoiceDetailPage } from './pages/InvoiceDetail';
import { PeoplePage } from './pages/People';
import { EmployeePage } from './pages/EmployeePage';
import { SettingsPage } from './pages/Settings';
import { DashboardsPage } from './pages/Dashboards';
import { ResourcingPage } from './pages/Resourcing';
import { ProfilePage } from './pages/Profile';
import { DownloadPage } from './pages/Download';
import { ModuleGate } from './components/ModuleGate';

const routes: RouteDef[] = [
  { pattern: '/', render: () => <DashboardPage /> },
  { pattern: '/my-tasks', render: () => <MyTasksPage /> },
  { pattern: '/crm', render: () => <ModuleGate module="crm"><CrmPage /></ModuleGate> },
  { pattern: '/crm/:tab', render: (p) => <ModuleGate module="crm"><CrmPage tab={p.tab} /></ModuleGate> },
  { pattern: '/companies', render: () => <ModuleGate module="crm"><CrmPage tab="clients" /></ModuleGate> },
  { pattern: '/companies/:id', render: (p) => <ModuleGate module="crm"><CompanyDetailPage id={p.id!} /></ModuleGate> },
  { pattern: '/deals', render: () => <ModuleGate module="crm"><CrmPage tab="deals" /></ModuleGate> },
  { pattern: '/deals/:id', render: (p) => <ModuleGate module="crm"><DealDetailPage id={p.id!} /></ModuleGate> },
  { pattern: '/projects', render: () => <ProjectsPage /> },
  { pattern: '/projects/:id', render: (p) => <ProjectDetailPage id={p.id!} /> },
  { pattern: '/projects/:id/tasks/:taskId', render: (p) => <TaskPage projectId={p.id!} taskId={p.taskId!} /> },
  { pattern: '/kb', render: () => <ModuleGate module="kb"><KbPage /></ModuleGate> },
  { pattern: '/kb/:spaceId', render: (p) => <ModuleGate module="kb"><KbPage spaceId={p.spaceId} /></ModuleGate> },
  { pattern: '/kb/:spaceId/:pageId', render: (p) => <ModuleGate module="kb"><KbPage spaceId={p.spaceId} pageId={p.pageId} /></ModuleGate> },
  { pattern: '/time', render: () => <ModuleGate module="time"><TimePage /></ModuleGate> },
  { pattern: '/finance', render: () => <ModuleGate module="finance"><FinancePage /></ModuleGate> },
  { pattern: '/finance/invoices/:id', render: (p) => <ModuleGate module="finance"><InvoiceDetailPage id={p.id!} /></ModuleGate> },
  { pattern: '/people', render: () => <ModuleGate module="people"><PeoplePage /></ModuleGate> },
  { pattern: '/people/:id', render: (p) => <ModuleGate module="people"><EmployeePage id={p.id!} /></ModuleGate> },
  { pattern: '/settings', render: () => <SettingsPage /> },
  { pattern: '/settings/:section', render: (p) => <SettingsPage section={p.section} /> },
  { pattern: '/dashboards', render: () => <ModuleGate module="dashboards"><DashboardsPage /></ModuleGate> },
  { pattern: '/dashboards/:id', render: (p) => <ModuleGate module="dashboards"><DashboardsPage id={p.id} /></ModuleGate> },
  { pattern: '/resourcing', render: () => <ModuleGate module="resourcing"><ResourcingPage /></ModuleGate> },
  { pattern: '/profile', render: () => <ProfilePage /> },
  { pattern: '/download', render: () => <DownloadPage /> },
];

export function AppRoutes() {
  // Keyed by pathname so a crash on one page doesn't poison the next route.
  const path = usePathname();
  return (
    <ErrorBoundary key={path}>
      <Routes routes={routes} />
    </ErrorBoundary>
  );
}
