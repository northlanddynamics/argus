import { createTransport } from "nodemailer";

export type MailMessage = { to: string; subject: string; text: string };

export interface Mailer {
  send(message: MailMessage): Promise<void>;
}

/** Logs mail instead of sending it; for local development. */
export const consoleMailer: Mailer = {
  async send(message) {
    console.log(`[mail] to=${message.to} subject=${message.subject}\n${message.text}`);
  },
};

export function smtpMailer(url: string, from: string): Mailer {
  const transport = createTransport(url);
  return {
    async send(message) {
      await transport.sendMail({ from, ...message });
    },
  };
}

/** Captures mail in memory; tests read `messages`. */
export function captureOutbox() {
  const messages: MailMessage[] = [];
  const mailer: Mailer = {
    async send(message) {
      messages.push(message);
    },
  };
  return { mailer, messages };
}
