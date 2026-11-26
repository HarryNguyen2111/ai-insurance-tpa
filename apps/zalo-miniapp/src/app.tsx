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
            </AnimationRoutes>
          </ZMPRouter>
        </PrototypeProvider>
      </SnackbarProvider>
    </ZaloApp>
  );
}
