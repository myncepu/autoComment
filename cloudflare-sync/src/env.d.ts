declare global {
  interface Env {
    BOOTSTRAP_CURSOR_SIGNING_KEY: string;
  }

  namespace Cloudflare {
    interface Env {
      BOOTSTRAP_CURSOR_SIGNING_KEY: string;
    }
  }
}

export {};
