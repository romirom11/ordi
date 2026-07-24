import { Routes, type RouteDef } from './lib/router';
import { DashboardPage } from './pages/Dashboard';
import { MyTasksPage } from './pages/MyTasks';
import { CompanyDetailPage } from './pages/CompanyDetail';
import { CrmPage } from './pages/Crm';
import { ProjectsPage } from './pages/Projects';
import { ProjectDetailPage } from './pages/ProjectDetail';
import { TaskPage } from './pages/TaskPage';
import { KbPage } from './pages/Kb';
import { TimePage } from './pages/Time';
import { FinancePage } from './pages/Finance';
import { InvoiceDetailPage } from './pages/InvoiceDetail';
import { PeoplePage } from './pages/People';
import { SettingsPage } from './pages/Settings';
import { DashboardsPage } from './pages/Dashboards';
import { ResourcingPage } from './pages/Resourcing';
import { ProfilePage } from './pages/Profile';

const routes: RouteDef[] = [
  { pattern: '/', render: () => <DashboardPage /> },
  { pattern: '/my-tasks', render: () => <MyTasksPage /> },
  { pattern: '/crm', render: () => <CrmPage /> },
  { pattern: '/crm/:tab', render: (p) => <CrmPage tab={p.tab} /> },
  { pattern: '/companies', render: () => <CrmPage tab="clients" /> },
  { pattern: '/companies/:id', render: (p) => <CompanyDetailPage id={p.id!} /> },
  { pattern: '/deals', render: () => <CrmPage tab="deals" /> },
  { pattern: '/projects', render: () => <ProjectsPage /> },
  { pattern: '/projects/:id', render: (p) => <ProjectDetailPage id={p.id!} /> },
  { pattern: '/projects/:id/tasks/:taskId', render: (p) => <TaskPage projectId={p.id!} taskId={p.taskId!} /> },
  { pattern: '/kb', render: () => <KbPage /> },
  { pattern: '/kb/:spaceId', render: (p) => <KbPage spaceId={p.spaceId} /> },
  { pattern: '/kb/:spaceId/:pageId', render: (p) => <KbPage spaceId={p.spaceId} pageId={p.pageId} /> },
  { pattern: '/time', render: () => <TimePage /> },
  { pattern: '/finance', render: () => <FinancePage /> },
  { pattern: '/finance/invoices/:id', render: (p) => <InvoiceDetailPage id={p.id!} /> },
  { pattern: '/people', render: () => <PeoplePage /> },
  { pattern: '/settings', render: () => <SettingsPage /> },
  { pattern: '/settings/:section', render: (p) => <SettingsPage section={p.section} /> },
  { pattern: '/dashboards', render: () => <DashboardsPage /> },
  { pattern: '/dashboards/:id', render: (p) => <DashboardsPage id={p.id} /> },
  { pattern: '/resourcing', render: () => <ResourcingPage /> },
  { pattern: '/profile', render: () => <ProfilePage /> },
];

export function AppRoutes() {
  return <Routes routes={routes} />;
}
