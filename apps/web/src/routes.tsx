import { Routes, type RouteDef } from './lib/router';
import { DashboardPage } from './pages/Dashboard';
import { MyTasksPage } from './pages/MyTasks';
import { CompaniesPage } from './pages/Companies';
import { CompanyDetailPage } from './pages/CompanyDetail';
import { DealsPage } from './pages/Deals';
import { ProjectsPage } from './pages/Projects';
import { ProjectDetailPage } from './pages/ProjectDetail';
import { KbPage } from './pages/Kb';
import { TimePage } from './pages/Time';
import { FinancePage } from './pages/Finance';
import { InvoiceDetailPage } from './pages/InvoiceDetail';
import { PeoplePage } from './pages/People';
import { SettingsPage } from './pages/Settings';

const routes: RouteDef[] = [
  { pattern: '/', render: () => <DashboardPage /> },
  { pattern: '/my-tasks', render: () => <MyTasksPage /> },
  { pattern: '/companies', render: () => <CompaniesPage /> },
  { pattern: '/companies/:id', render: (p) => <CompanyDetailPage id={p.id!} /> },
  { pattern: '/deals', render: () => <DealsPage /> },
  { pattern: '/projects', render: () => <ProjectsPage /> },
  { pattern: '/projects/:id', render: (p) => <ProjectDetailPage id={p.id!} /> },
  { pattern: '/projects/:id/tasks/:taskId', render: (p) => <ProjectDetailPage id={p.id!} taskId={p.taskId} /> },
  { pattern: '/kb', render: () => <KbPage /> },
  { pattern: '/kb/:spaceId', render: (p) => <KbPage spaceId={p.spaceId} /> },
  { pattern: '/kb/:spaceId/:pageId', render: (p) => <KbPage spaceId={p.spaceId} pageId={p.pageId} /> },
  { pattern: '/time', render: () => <TimePage /> },
  { pattern: '/finance', render: () => <FinancePage /> },
  { pattern: '/finance/invoices/:id', render: (p) => <InvoiceDetailPage id={p.id!} /> },
  { pattern: '/people', render: () => <PeoplePage /> },
  { pattern: '/settings', render: () => <SettingsPage /> },
  { pattern: '/settings/:section', render: (p) => <SettingsPage section={p.section} /> },
];

export function AppRoutes() {
  return <Routes routes={routes} />;
}
