"use client";

import { useEffect, useState } from "react";

interface BeforeInstallPromptEvent extends Event {
  prompt: () => Promise<void>;
  userChoice: Promise<{ outcome: "accepted" | "dismissed" }>;
}

export default function PWAInstall() {
  const [installPrompt, setInstallPrompt] = useState<BeforeInstallPromptEvent | null>(null);
  const [showBanner, setShowBanner] = useState(false);
  const [isIOS, setIsIOS] = useState(false);
  const [isStandalone, setIsStandalone] = useState(false);

  useEffect(() => {
    // Register service worker
    if ("serviceWorker" in navigator) {
      navigator.serviceWorker
        .register("/sw.js")
        .then((registration) => {
          console.log("EasyLearn SW registered:", registration.scope);
        })
        .catch((error) => {
          console.log("EasyLearn SW registration failed:", error);
        });
    }

    // Check if already installed
    const isInStandaloneMode = window.matchMedia("(display-mode: standalone)").matches 
      || (window.navigator as Navigator & { standalone?: boolean }).standalone === true;
    setIsStandalone(isInStandaloneMode);

    // Check if iOS
    const isIOSDevice = /iPad|iPhone|iPod/.test(navigator.userAgent);
    setIsIOS(isIOSDevice);

    // Listen for install prompt
    const handleBeforeInstall = (e: Event) => {
      e.preventDefault();
      setInstallPrompt(e as BeforeInstallPromptEvent);
      
      // Show banner if not dismissed recently
      const dismissed = localStorage.getItem("pwa_banner_dismissed");
      if (!dismissed || Date.now() - parseInt(dismissed) > 7 * 24 * 60 * 60 * 1000) {
        setShowBanner(true);
      }
    };

    window.addEventListener("beforeinstallprompt", handleBeforeInstall);

    // Show iOS banner if applicable
    if (isIOSDevice && !isInStandaloneMode) {
      const dismissed = localStorage.getItem("pwa_banner_dismissed");
      if (!dismissed || Date.now() - parseInt(dismissed) > 7 * 24 * 60 * 60 * 1000) {
        setTimeout(() => setShowBanner(true), 3000);
      }
    }

    return () => {
      window.removeEventListener("beforeinstallprompt", handleBeforeInstall);
    };
  }, []);

  const handleInstall = async () => {
    if (!installPrompt) return;
    
    installPrompt.prompt();
    const { outcome } = await installPrompt.userChoice;
    
    if (outcome === "accepted") {
      setShowBanner(false);
      setInstallPrompt(null);
    }
  };

  const dismissBanner = () => {
    setShowBanner(false);
    localStorage.setItem("pwa_banner_dismissed", Date.now().toString());
  };

  if (isStandalone || !showBanner) return null;

  return (
    <div className="fixed bottom-0 left-0 right-0 z-50 p-4 animate-slide-up">
      <div className="max-w-lg mx-auto bg-white rounded-2xl shadow-2xl border border-slate-200 p-4">
        <div className="flex items-start gap-3">
          <div className="w-12 h-12 rounded-xl gradient-primary flex items-center justify-center text-white font-bold text-lg shrink-0">
            EL
          </div>
          <div className="flex-1 min-w-0">
            <h3 className="font-bold text-slate-800 text-sm">Install EasyLearn</h3>
            <p className="text-xs text-slate-500 mt-0.5">
              {isIOS 
                ? "Tap the share button, then 'Add to Home Screen'"
                : "Add to your home screen for quick access"
              }
            </p>
          </div>
          <button
            onClick={dismissBanner}
            className="text-slate-400 hover:text-slate-600 p-1"
            aria-label="Dismiss"
          >
            ✕
          </button>
        </div>
        
        {isIOS ? (
          <div className="mt-3 p-3 rounded-xl bg-blue-50 border border-blue-100">
            <div className="flex items-center gap-2 text-sm text-blue-700">
              <span>1.</span>
              <span>Tap</span>
              <span className="inline-flex items-center justify-center w-6 h-6 bg-blue-100 rounded">
                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                  <path d="M4 12v8a2 2 0 002 2h12a2 2 0 002-2v-8M16 6l-4-4-4 4M12 2v13"/>
                </svg>
              </span>
              <span>Share</span>
            </div>
            <div className="flex items-center gap-2 text-sm text-blue-700 mt-1">
              <span>2.</span>
              <span>Scroll down and tap &quot;Add to Home Screen&quot;</span>
            </div>
          </div>
        ) : (
          <div className="mt-3 flex gap-2">
            <button
              onClick={dismissBanner}
              className="flex-1 py-2.5 rounded-xl bg-slate-100 text-slate-600 text-sm font-semibold"
            >
              Not now
            </button>
            <button
              onClick={handleInstall}
              className="flex-1 py-2.5 rounded-xl gradient-primary text-white text-sm font-semibold shadow-lg"
            >
              Install App
            </button>
          </div>
        )}
      </div>
    </div>
  );
}
