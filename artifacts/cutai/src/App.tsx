import { Switch, Route, Router as WouterRouter } from "wouter";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { Toaster } from "@/components/ui/toaster";
import { TooltipProvider } from "@/components/ui/tooltip";
import NotFound from "@/pages/not-found";

import { AppLayout } from "@/components/layout/app-layout";
import Dashboard from "@/pages/dashboard";
import Projects from "@/pages/projects";
import NewProject from "@/pages/projects/new";
import BatchProject from "@/pages/projects/batch";
import ProjectWorkspace from "@/pages/projects/[id]";
import ProjectJobs from "@/pages/projects/[id]/jobs";
import ProjectExports from "@/pages/projects/[id]/exports";
import Intelligence from "@/pages/intelligence";
import StyleProfiles from "@/pages/style-profiles";

const queryClient = new QueryClient();

function Router() {
  return (
    <AppLayout>
      <Switch>
        <Route path="/" component={Dashboard} />
        <Route path="/projects" component={Projects} />
        <Route path="/projects/new" component={NewProject} />
        <Route path="/projects/batch" component={BatchProject} />
        <Route path="/projects/:id/jobs" component={ProjectJobs} />
        <Route path="/projects/:id/exports" component={ProjectExports} />
        <Route path="/projects/:id" component={ProjectWorkspace} />
        <Route path="/intelligence" component={Intelligence} />
        <Route path="/style-profiles" component={StyleProfiles} />
        <Route component={NotFound} />
      </Switch>
    </AppLayout>
  );
}

function App() {
  return (
    <QueryClientProvider client={queryClient}>
      <TooltipProvider>
        <WouterRouter base={import.meta.env.BASE_URL.replace(/\/$/, "")}>
          <Router />
        </WouterRouter>
        <Toaster />
      </TooltipProvider>
    </QueryClientProvider>
  );
}

export default App;
