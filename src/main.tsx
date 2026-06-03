import React from "react";
import ReactDOM from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { AskProvider } from "./context/AskContext";
import { OnboardingProvider } from "@/features/onboarding/OnboardingContext";
import App from "./App";
import "./index.css";

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      staleTime: 30_000,
      retry: 1,
    },
  },
});

ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
  <React.StrictMode>
    <QueryClientProvider client={queryClient}>
      <OnboardingProvider>
        <AskProvider>
          <App />
        </AskProvider>
      </OnboardingProvider>
    </QueryClientProvider>
  </React.StrictMode>,
);
