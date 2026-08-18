import { BrowserRouter, Navigate, Outlet, Route, Routes } from 'react-router-dom';
import { AuthProvider } from '../auth/AuthProvider.js';
import { ProtectedRoute, PublicOnlyRoute, RoleGate } from '../auth/ProtectedRoute.js';
import { ChangePasswordPage } from '../features/auth/ChangePasswordPage.js';
import { LoginPage } from '../features/auth/LoginPage.js';
import { CreateGamePage } from '../features/games/CreateGamePage.js';
import { GamePage } from '../features/games/GamePage.js';
import { HomePage } from '../features/home/HomePage.js';
import { ProfilePage } from '../features/profile/ProfilePage.js';
import { RakeSettingsPage } from '../features/settings/RakeSettingsPage.js';
import { UserFormPage } from '../features/users/UserFormPage.js';
import { UserListPage } from '../features/users/UserListPage.js';
import { SettlementWizardPage } from '../features/settlements/SettlementWizardPage.js';
import { AllPlayerSummaryPage } from '../features/history/AllPlayerSummaryPage.js';
import { GameSelectionPage } from '../features/history/GameSelectionPage.js';
import { HistoryPage } from '../features/history/HistoryPage.js';
import { SettlementDetailPage } from '../features/history/SettlementDetailPage.js';
import { AppShell, OfflineBanner } from './AppShell.js';

function ProtectedShell() {
  return <ProtectedRoute><AppShell /></ProtectedRoute>;
}

export function AppRouter() {
  return <BrowserRouter><AuthProvider><OfflineBanner /><Routes>
    <Route path="/login" element={<PublicOnlyRoute><LoginPage /></PublicOnlyRoute>} />
    <Route path="/change-password" element={<ProtectedRoute><ChangePasswordPage /></ProtectedRoute>} />
    <Route element={<ProtectedShell />}>
      <Route index element={<HomePage />} />
      <Route path="history" element={<HistoryPage />} />
      <Route path="history/select" element={<GameSelectionPage />} />
      <Route path="history/summary" element={<AllPlayerSummaryPage />} />
      <Route path="history/:id" element={<SettlementDetailPage />} />
      <Route path="profile" element={<ProfilePage />} />
      <Route path="games/new" element={<RoleGate roles={['ADMIN', 'SUPER_ADMIN']}><CreateGamePage /></RoleGate>} />
      <Route path="games/:id" element={<GamePage />} />
      <Route path="games/:id/settlement" element={<RoleGate roles={['ADMIN', 'SUPER_ADMIN']}><SettlementWizardPage /></RoleGate>} />
      <Route path="users" element={<RoleGate roles={['ADMIN', 'SUPER_ADMIN']}><UserListPage /></RoleGate>} />
      <Route path="users/new" element={<RoleGate roles={['ADMIN', 'SUPER_ADMIN']}><UserFormPage mode="create" /></RoleGate>} />
      <Route path="users/:id/edit" element={<RoleGate roles={['ADMIN', 'SUPER_ADMIN']}><UserFormPage mode="edit" /></RoleGate>} />
      <Route path="settings/rake" element={<RoleGate roles={['SUPER_ADMIN']}><RakeSettingsPage /></RoleGate>} />
      <Route path="*" element={<Navigate to="/" replace />} />
    </Route>
    <Route path="*" element={<Navigate to="/" replace />} />
  </Routes></AuthProvider></BrowserRouter>;
}

export function ProtectedOutlet() {
  return <ProtectedRoute><Outlet /></ProtectedRoute>;
}
