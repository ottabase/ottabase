import type { TransportOptions } from 'nodemailer';
import nodemailer from 'nodemailer';
import type { Mailer, SendEmailInput, SendEmailResult } from '../types';
import { formatAddress, normalizeAddressList } from '../address';

export interface NodemailerMailerOptions {
    server: string | TransportOptions;
}

export function createNodemailerMailer(options: NodemailerMailerOptions): Mailer {
    const provider = 'nodemailer';
    const transport = nodemailer.createTransport(options.server);

    return {
        provider,
        async send(input: SendEmailInput): Promise<SendEmailResult> {
            try {
                const result = await transport.sendMail({
                    from: formatAddress(input.from),
                    to: normalizeAddressList(input.to),
                    cc: normalizeAddressList(input.cc),
                    bcc: normalizeAddressList(input.bcc),
                    replyTo: input.replyTo ? formatAddress(input.replyTo) : undefined,
                    subject: input.subject,
                    html: input.html,
                    text: input.text,
                    headers: input.headers,
                });

                return {
                    provider,
                    success: true,
                    id: result.messageId,
                    raw: result,
                };
            } catch (error) {
                return {
                    provider,
                    success: false,
                    error: error instanceof Error ? error.message : 'Unknown error',
                };
            }
        },
    };
}
