import { AudioSample, CustomAudioDecoder, registerDecoder } from 'mediabunny';
import type { AudioCodec, EncodedPacket } from 'mediabunny';

const AAC_MAIN_CODEC = 'mp4a.40.1';
const AAC_LC_CODEC = 'mp4a.40.2';

// Broadcast MPEG-TS streams sometimes flag AAC-LC or HE-AAC audio as AAC Main
// in their ADTS headers. Browsers reject the mp4a.40.1 codec string but decode
// the frames once they are labelled AAC-LC, so relabel the configuration here.
class AacMainRelabelDecoder extends CustomAudioDecoder {
  private decoder: AudioDecoder | null = null;

  static override supports(codec: AudioCodec, config: AudioDecoderConfig): boolean {
    return codec === 'aac' && config.codec === AAC_MAIN_CODEC;
  }

  init(): void {
    this.decoder = new AudioDecoder({
      output: (data) => this.onSample(new AudioSample(data)),
      error: (error) => this.onError(error),
    });
    this.decoder.configure({ ...this.config, codec: AAC_LC_CODEC });
  }

  decode(packet: EncodedPacket): void {
    this.decoder?.decode(packet.toEncodedAudioChunk());
  }

  async flush(): Promise<void> {
    await this.decoder?.flush();
  }

  close(): void {
    if (this.decoder && this.decoder.state !== 'closed') this.decoder.close();
    this.decoder = null;
  }
}

let registered = false;
export function registerAacMainRelabelDecoder(): void {
  if (registered) return;
  registered = true;
  registerDecoder(AacMainRelabelDecoder);
}
