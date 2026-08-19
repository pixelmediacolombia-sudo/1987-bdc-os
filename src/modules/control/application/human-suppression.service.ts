import { ContactMutex } from "@/modules/control/application/contact-mutex";
import type { BurstBufferCancellationPort } from "@/modules/control/application/ports/burst-buffer.port";
import type {
  HumanSuppressionInput,
  HumanSuppressionPort,
} from "@/modules/control/application/ports/human-suppression.port";

export type HumanSuppressionLogger = {
  info(message: string): void;
};

const defaultLogger: HumanSuppressionLogger = {
  info: (message) => console.info(message),
};

export class HumanSuppressionService implements HumanSuppressionPort {
  constructor(
    private readonly burstBuffer: BurstBufferCancellationPort,
    private readonly mutex: ContactMutex,
    private readonly logger: HumanSuppressionLogger = defaultLogger,
  ) {}

  async suppress(input: HumanSuppressionInput): Promise<void> {
    const contactId = input.contactId.trim();
    if (!contactId) throw new Error("Human suppression contactId cannot be empty");

    await this.burstBuffer.cancel(contactId);
    await this.mutex.release(contactId);
    this.logger.info(`Human suppression completed for contact ${contactId}; trigger=${input.trigger}`);
  }
}
