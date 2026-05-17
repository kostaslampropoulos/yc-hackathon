import type { Metadata } from "next";
import Link from "next/link";
import { Geist, Geist_Mono, Instrument_Sans, Merriweather } from "next/font/google";
import { ClerkProvider, SignInButton, SignUpButton, Show, UserButton } from "@clerk/nextjs";
import { Toaster } from "@/components/ui/sonner";
import "./globals.css";
import { cn } from "@/lib/utils";
import PixelFire from "@/components/pixel-fire";

const merriweatherHeading = Merriweather({ subsets: ["latin"], variable: "--font-heading", weight: ["400", "700"] });

const instrumentSans = Instrument_Sans({ subsets: ["latin"], variable: "--font-sans" });

const geistSans = Geist({
  variable: "--font-geist-sans",
  subsets: ["latin"],
});

const geistMono = Geist_Mono({
  variable: "--font-geist-mono",
  subsets: ["latin"],
});

export const metadata: Metadata = {
  title: "Receptionist",
  description: "Spin up an AI receptionist for any local business in 60 seconds.",
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <ClerkProvider>
      <html
        lang="en"
        className={cn(
          "h-full",
          "antialiased",
          geistSans.variable,
          geistMono.variable,
          "font-sans",
          instrumentSans.variable,
          merriweatherHeading.variable,
        )}
      >
        <body className="min-h-full flex flex-col bg-background text-foreground">
          {/* Fixed fire layer, sticks on scroll */}
          <div
            className="fixed inset-0 z-0 pointer-events-none opacity-20"
            style={{
              maskImage: 'linear-gradient(to top, black 0%, black 40%, transparent 90%)',
              WebkitMaskImage: 'linear-gradient(to top, black 0%, black 40%, transparent 90%)',
            }}
          >
            <PixelFire color="#007A55" pixelSize={4} fps={30} />
          </div>

          <header className="relative z-10 flex items-center justify-between px-6 py-4">
            <Link href="/" className="font-semibold tracking-tight text-lg hover:opacity-60 cursor-pointer transition-all" style={{ fontFamily: "var(--font-heading)" }}>
              Fireside
            </Link>
            <div className="flex items-center gap-3">
              <Show when="signed-out">
                <SignInButton mode="modal">
                  <button className="text-sm font-medium hover:underline">Sign in</button>
                </SignInButton>
                <SignUpButton mode="modal">
                  <button className="text-sm font-medium px-3 py-1.5 rounded-md bg-primary text-primary-foreground hover:opacity-90">
                    Sign up
                  </button>
                </SignUpButton>
              </Show>
              <Show when="signed-in">
                <UserButton />
              </Show>
            </div>
          </header>
          <main className="relative z-10 flex flex-1 flex-col">{children}</main>
          <Toaster />
        </body>
      </html>
    </ClerkProvider>
  );
}
