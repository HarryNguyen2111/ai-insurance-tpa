import { App as ZaloApp, AnimationRoutes, Route, SnackbarProvider, ZMPRouter } from 'zmp-ui';
import type { RuntimeKind } from './lib/platform.ts';
import { PrototypeProvider } from './state.tsx';
import { OnboardingPage } from './pages/onboarding.tsx';
import { ConsentPage, ConsentDeniedPage } from './pages/consent.tsx';
import { HomePage } from './pages/home.tsx';
import { ECardPage } from './pages/ecard.tsx';
import { FnolPage } from './pages/fnol.tsx';
import { ClaimDetailPage, ClaimsPage } from './pages/claims.tsx';
import { EobPage } from './pages/eob.tsx';
import { useInertExitingScreens } from './components/screen-transition.ts';
import { BottomNav } from './components/bottom-nav.tsx';
import { ActivityPage, HubPage } from './pages/hub.tsx';
import { LoyaltyPage } from './pages/loyalty.tsx';
import { PersonalPage } from './pages/personal.tsx';
import { WorkspaceSheet } from './components/workspace-sheet.tsx';
import { PendingWorkDialog, SwitchToast } from './components/switch-feedback.tsx';

export function App({ runtime }: { runtime: RuntimeKind }) {
  // Outgoing screen stays mounted during the zmp-ui page transition; take it out of a11y/interaction.
  useInertExitingScreens();
  return (
    <ZaloApp>
      <SnackbarProvider>
        <PrototypeProvider runtime={runtime}>
          {/* memoryRouter: works identically in the browser fallback and the Zalo webview. */}
          <ZMPRouter memoryRouter>
            <AnimationRoutes>
              <Route path="/" element={<OnboardingPage />} />
              <Route path="/consent" element={<ConsentPage />} />
              <Route path="/consent/denied" element={<ConsentDeniedPage />} />
              <Route path="/home" element={<HomePage />} />
              <Route path="/ecard" element={<ECardPage />} />
              <Route path="/claims/new" element={<FnolPage />} />
              <Route path="/claims" element={<ClaimsPage />} />
              <Route path="/claims/:claimId" element={<ClaimDetailPage />} />
              <Route path="/claims/:claimId/eob" element={<EobPage />} />
              {/* #106 user-centric hub: H0 home / personal Loyalty360, H2 Loyalty360, H4 activity, H5 personal */}
              <Route path="/hub" element={<HubPage />} />
              <Route path="/loyalty" element={<LoyaltyPage />} />
              <Route path="/hub/activity" element={<ActivityPage />} />
              <Route path="/hub/personal" element={<PersonalPage />} />
            </AnimationRoutes>
            {/* Persistent bar lives outside AnimationRoutes: one instance, never part of an exiting screen. */}
            <BottomNav />
            {/* Single instances outside AnimationRoutes: never duplicated by a screen transition. */}
            <WorkspaceSheet />
            <PendingWorkDialog />
            <SwitchToast />
          </ZMPRouter>
        </PrototypeProvider>
      </SnackbarProvider>
    </ZaloApp>
  );
}
