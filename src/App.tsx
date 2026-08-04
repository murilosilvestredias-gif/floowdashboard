import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { BrowserRouter, Navigate, Route, Routes } from "react-router-dom";
import { Toaster as Sonner } from "@/components/ui/sonner";
import { Toaster } from "@/components/ui/toaster";
import { TooltipProvider } from "@/components/ui/tooltip";
import { ProtectedRoute } from "@/components/ProtectedRoute";
import { ErrorBoundary } from "@/components/ErrorBoundary";
import LoginPage from "./pages/Login";
import ResetPasswordPage from "./pages/ResetPassword";
import AdminPage from "./pages/Admin";
import DashboardPage from "./pages/Dashboard";
import LeadsPage from "./pages/Leads";
import KanbanPage from "./pages/Kanban";
import CalendarioPage from "./pages/CalendarioPage";
import CampanhasPage from "./pages/Campanhas";
import CriativosPage from "./pages/Criativos";
import WebhookPage from "./pages/Webhook";
import WhatsAppPage from "./pages/WhatsApp";
import WhatsAppConfigPage from "./pages/WhatsAppConfig";
import DisparosPage from "./pages/Disparos";
import ConfiguracoesPage from "./pages/Configuracoes";
import MetaAdsPage from "./pages/MetaAds";
import ReportsPage from "./pages/Reports";
import InvitePage from "./pages/InvitePage";
import QuizPublico from "./pages/QuizPublico";
import QuizBuilder from "./pages/Quiz";
import QuizRespostas from "./pages/QuizRespostas";
import AssinaturaPage from "./pages/Assinatura";
import GestorPage from "./pages/Gestor";
import OrigenPage from "./pages/Origens";
import NotFound from "./pages/NotFound";

const queryClient = new QueryClient();

const App = () => (
  <QueryClientProvider client={queryClient}>
    <TooltipProvider>
      <Toaster />
      <Sonner />
      <BrowserRouter>
        <Routes>
          <Route path="/login" element={<LoginPage />} />
          <Route path="/reset-password" element={<ResetPasswordPage />} />
          <Route path="/admin" element={<ProtectedRoute><AdminPage /></ProtectedRoute>} />
          <Route path="/sem-acesso" element={<Navigate to="/" replace />} />
          <Route path="/" element={<ProtectedRoute><ErrorBoundary><DashboardPage /></ErrorBoundary></ProtectedRoute>} />
          <Route path="/leads" element={<ProtectedRoute><LeadsPage /></ProtectedRoute>} />
          <Route path="/kanban" element={<ProtectedRoute><KanbanPage /></ProtectedRoute>} />
          <Route path="/calendario" element={<ProtectedRoute><CalendarioPage /></ProtectedRoute>} />
          <Route path="/campanhas" element={<ProtectedRoute><CampanhasPage /></ProtectedRoute>} />
          <Route path="/criativos" element={<ProtectedRoute><CriativosPage /></ProtectedRoute>} />
          <Route path="/webhook" element={<ProtectedRoute><WebhookPage /></ProtectedRoute>} />
          <Route path="/whatsapp" element={<ProtectedRoute><WhatsAppPage /></ProtectedRoute>} />
          <Route path="/whatsapp/disparos" element={<ProtectedRoute><DisparosPage /></ProtectedRoute>} />
          <Route path="/whatsapp/configuracoes" element={<ProtectedRoute><WhatsAppConfigPage /></ProtectedRoute>} />
          <Route path="/disparos" element={<Navigate to="/whatsapp/disparos" replace />} />
          <Route path="/configuracoes" element={<ProtectedRoute><ConfiguracoesPage /></ProtectedRoute>} />
          <Route path="/meta-ads" element={<ProtectedRoute><MetaAdsPage /></ProtectedRoute>} />
          <Route path="/reports" element={<ProtectedRoute><ReportsPage /></ProtectedRoute>} />
          <Route path="/convidar" element={<ProtectedRoute><InvitePage /></ProtectedRoute>} />
          <Route path="/quiz-builder" element={<ProtectedRoute><QuizBuilder /></ProtectedRoute>} />
          <Route path="/quiz/respostas" element={<ProtectedRoute><QuizRespostas /></ProtectedRoute>} />
          <Route path="/origens" element={<ProtectedRoute><OrigenPage /></ProtectedRoute>} />
          <Route path="/assinatura" element={<ProtectedRoute><AssinaturaPage /></ProtectedRoute>} />
          <Route path="/gestor" element={<ProtectedRoute><GestorPage /></ProtectedRoute>} />
          <Route path="/quiz/:slug" element={<QuizPublico />} />
          <Route path="*" element={<NotFound />} />
        </Routes>
      </BrowserRouter>
    </TooltipProvider>
  </QueryClientProvider>
);

export default App;
