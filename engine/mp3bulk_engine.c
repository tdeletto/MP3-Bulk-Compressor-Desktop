/*
 * mp3bulk-engine: the native half of MP3 Bulk Compressor Desktop.
 *
 * A small command-line helper that the desktop app runs once per file. It decodes MP3 audio with
 * minimp3 and re-encodes it with LAME 3.100, using the same encoder settings as the Android app's
 * JNI bridge (lame_jni.c). All file-safety logic (planning, verification, saving, Trash) lives in
 * the JavaScript side; this program only turns bytes into bytes and reports what it saw.
 *
 * Commands
 *   mp3bulk-engine version
 *   mp3bulk-engine encode  IN OUT MODE KBPS RATE CHANNELS HIGHPASS LOWPASS AUDIO_START AUDIO_END
 *       MODE      0 = CBR, 1 = VBR, 2 = ABR           (matches EncodeMode in settings.js)
 *       CHANNELS  0 = mono, 1 = full stereo, 2 = joint (matches ChannelOut in settings.js)
 *       AUDIO_START / AUDIO_END  byte range of the MPEG audio; bytes before START (ID3v2) and from
 *       END to EOF (ID3v1) are copied into OUT unchanged, so tags and cover art survive byte for byte.
 *   mp3bulk-engine inspect IN
 *       Decodes the whole file and reports sample rate, channels, decoded length and RMS level.
 *
 * Output protocol (stdout, one line each)
 *   progress <0..1>        while working
 *   result <json>          on success (exit code 0)
 *   error <message>        on failure (exit code 1)
 */
#define MINIMP3_IMPLEMENTATION
#include "minimp3_ex.h"
#include "lame.h"

#include <math.h>
#include <stdarg.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

#ifdef _WIN32
#include <windows.h>
#endif

#define ENGINE_VERSION "1.0.0"

/* Bitrate modes, must match EncodeMode in src/core/settings.js */
#define MODE_CBR 0
#define MODE_VBR 1
#define MODE_ABR 2

/* Channel modes, must match ChannelOut in src/core/settings.js */
#define CH_MONO 0
#define CH_STEREO 1
#define CH_JOINT 2

#define HIGHPASS_HZ 80
#define LOWPASS_HZ 15000

static void fail(const char *fmt, ...) {
    va_list ap;
    va_start(ap, fmt);
    fputs("error ", stdout);
    vfprintf(stdout, fmt, ap);
    fputc('\n', stdout);
    va_end(ap);
    fflush(stdout);
    exit(1);
}

/* Prints progress only when the whole percentage changes, to keep the pipe quiet. */
static void progress(double fraction, int *last_pct) {
    int pct = (int) (fraction * 100.0);
    if (pct < 0) pct = 0;
    if (pct > 100) pct = 100;
    if (pct == *last_pct) return;
    *last_pct = pct;
    printf("progress %.2f\n", pct / 100.0);
    fflush(stdout);
}

/* ---------- File helpers (UTF-8 paths on every platform) ---------- */

static FILE *open_utf8(const char *path, const char *mode) {
#ifdef _WIN32
    /* fopen() on Windows uses the ANSI code page; convert so non-Latin file names work. */
    wchar_t wpath[32768], wmode[8];
    if (!MultiByteToWideChar(CP_UTF8, 0, path, -1, wpath, 32768)) return NULL;
    if (!MultiByteToWideChar(CP_UTF8, 0, mode, -1, wmode, 8)) return NULL;
    return _wfopen(wpath, wmode);
#else
    return fopen(path, mode);
#endif
}

/* Reads a whole file into memory. MP3s are small enough that this is simpler and faster than streaming. */
static uint8_t *read_all(const char *path, size_t *size_out) {
    FILE *f = open_utf8(path, "rb");
    if (!f) fail("Can't open file");
    size_t cap = 1 << 20, len = 0;
    uint8_t *buf = malloc(cap);
    if (!buf) fail("Out of memory");
    for (;;) {
        if (len == cap) {
            cap *= 2;
            uint8_t *grown = realloc(buf, cap);
            if (!grown) fail("Out of memory");
            buf = grown;
        }
        size_t n = fread(buf + len, 1, cap - len, f);
        len += n;
        if (n == 0) break;
    }
    if (ferror(f)) fail("Can't read file");
    fclose(f);
    *size_out = len;
    return buf;
}

static void write_all(FILE *f, const uint8_t *data, size_t n) {
    if (n && fwrite(data, 1, n, f) != n) fail("Can't write output (disk full?)");
}

/* ---------- 80 Hz high-pass filter ---------- */

/*
 * LAME's own high-pass works on its 32 polyphase bands and refuses anything below roughly
 * 0.75/31 of Nyquist (~530 Hz at 44.1 kHz): lame_set_highpassfreq(80) just prints
 * "highpass filter disabled" and does nothing. So the filter is applied to the PCM instead,
 * before encoding: a 2nd-order Butterworth high-pass (RBJ cookbook biquad), -12 dB/octave.
 */
typedef struct {
    double b0, b1, b2, a1, a2;
    double x1[2], x2[2], y1[2], y2[2];
} highpass_t;

static void highpass_init(highpass_t *f, double sample_rate, double cutoff_hz) {
    const double pi = 3.14159265358979323846;
    double w0 = 2.0 * pi * cutoff_hz / sample_rate;
    double cosw = cos(w0), alpha = sin(w0) / sqrt(2.0); /* Q = 1/sqrt(2) */
    double a0 = 1.0 + alpha;
    memset(f, 0, sizeof *f);
    f->b0 = (1.0 + cosw) / 2.0 / a0;
    f->b1 = -(1.0 + cosw) / a0;
    f->b2 = (1.0 + cosw) / 2.0 / a0;
    f->a1 = -2.0 * cosw / a0;
    f->a2 = (1.0 - alpha) / a0;
}

/* Filters interleaved 16-bit samples in place; state carries across calls. */
static void highpass_apply(highpass_t *f, int16_t *pcm, int frames, int channels) {
    for (int i = 0; i < frames; i++) {
        for (int c = 0; c < channels; c++) {
            double x = pcm[i * channels + c];
            double y = f->b0 * x + f->b1 * f->x1[c] + f->b2 * f->x2[c] - f->a1 * f->y1[c] - f->a2 * f->y2[c];
            f->x2[c] = f->x1[c];
            f->x1[c] = x;
            f->y2[c] = f->y1[c];
            f->y1[c] = y;
            long v = lrint(y);
            pcm[i * channels + c] = (int16_t) (v > 32767 ? 32767 : v < -32768 ? -32768 : v);
        }
    }
}

/* ---------- LAME configuration (ported from the Android app's lame_jni.c) ---------- */

/* Approximate LAME 3.100 average bitrates for -V0..-V9 (44.1 kHz stereo). */
static const float V_KBPS[10] = {245, 225, 190, 175, 165, 130, 115, 100, 85, 65};

/* Maps a target average bitrate to a (fractional) VBR quality, 0 = best. */
static float vbr_quality_for_kbps(int kbps) {
    if (kbps >= V_KBPS[0]) return 0.0f;
    for (int i = 1; i < 10; i++) {
        if (kbps >= V_KBPS[i]) {
            float span = V_KBPS[i - 1] - V_KBPS[i];
            return (float) i - (kbps - V_KBPS[i]) / span;
        }
    }
    return 9.0f;
}

static lame_t configure(int in_rate, int channels, int out_rate, int mode, int kbps,
                        int channel_mode, int lowpass_hz) {
    lame_t gf = lame_init();
    if (!gf) return NULL;

    lame_set_in_samplerate(gf, in_rate);
    lame_set_num_channels(gf, channels);
    lame_set_out_samplerate(gf, out_rate);
    lame_set_mode(gf, channels == 1 ? MONO : (channel_mode == CH_STEREO ? STEREO : JOINT_STEREO));
    lame_set_quality(gf, 3);
    lame_set_write_id3tag_automatic(gf, 0);

    switch (mode) {
        case MODE_VBR:
            lame_set_VBR(gf, vbr_mtrh);
            lame_set_VBR_quality(gf, vbr_quality_for_kbps(kbps));
            /* Below V9's natural rate, cap peaks so the target is honoured. */
            if (kbps < V_KBPS[9]) lame_set_VBR_max_bitrate_kbps(gf, kbps * 3 / 2);
            lame_set_bWriteVbrTag(gf, 1);
            break;
        case MODE_ABR:
            lame_set_VBR(gf, vbr_abr);
            lame_set_VBR_mean_bitrate_kbps(gf, kbps);
            lame_set_bWriteVbrTag(gf, 1);
            break;
        default:
            lame_set_VBR(gf, vbr_off);
            lame_set_brate(gf, kbps);
            lame_set_bWriteVbrTag(gf, 0);
            break;
    }
    /* High-pass is applied to the PCM by highpass_apply(); see the note above it. */
    if (lowpass_hz > 0) lame_set_lowpassfreq(gf, lowpass_hz);

    if (lame_init_params(gf) < 0) {
        lame_close(gf);
        return NULL;
    }
    return gf;
}

static lame_t open_encoder(int in_rate, int channels, int out_rate, int mode, int kbps,
                           int channel_mode, int lowpass) {
    int lowpass_hz = 0;
    if (lowpass) {
        /* Never raise the encoder's own cutoff: use min(15 kHz, LAME's default for these settings). */
        lame_t probe = configure(in_rate, channels, out_rate, mode, kbps, channel_mode, 0);
        if (!probe) return NULL;
        int def = lame_get_lowpassfreq(probe);
        lame_close(probe);
        lowpass_hz = (def > 0 && def < LOWPASS_HZ) ? def : LOWPASS_HZ;
    }
    return configure(in_rate, channels, out_rate, mode, kbps, channel_mode, lowpass_hz);
}

/* ---------- Commands ---------- */

static int cmd_encode(char **argv) {
    const char *in_path = argv[0], *out_path = argv[1];
    int mode = atoi(argv[2]), kbps = atoi(argv[3]), rate = atoi(argv[4]), channel_mode = atoi(argv[5]);
    int highpass = atoi(argv[6]), lowpass = atoi(argv[7]);
    size_t size;
    uint8_t *src = read_all(in_path, &size);
    size_t audio_start = (size_t) strtoull(argv[8], NULL, 10);
    size_t audio_end = (size_t) strtoull(argv[9], NULL, 10);
    if (audio_end > size || audio_start > audio_end) fail("Bad audio range");

    static mp3dec_ex_t dec;
    if (mp3dec_ex_open_buf(&dec, src + audio_start, audio_end - audio_start, MP3D_SEEK_TO_SAMPLE))
        fail("Not a valid MP3 (no audio frames found)");
    if (dec.info.layer != 3) fail("Not an MP3 (MPEG Layer III) file");

    FILE *out = open_utf8(out_path, "wb");
    if (!out) fail("Can't create temporary output");
    write_all(out, src, audio_start); /* ID3v2 tag, byte for byte */

    lame_t gf = NULL;
    highpass_t hp;
    int in_rate = 0, in_ch = 0, out_ch = 0, last_pct = -1;
    uint64_t in_frames = 0;
    int16_t *mono = NULL;
    size_t mono_cap = 0;
    unsigned char *mp3 = NULL;
    size_t mp3_cap = 0;

    for (;;) {
        mp3d_sample_t *pcm = NULL;
        mp3dec_frame_info_t info;
        size_t n = mp3dec_ex_read_frame(&dec, &pcm, &info, MINIMP3_MAX_SAMPLES_PER_FRAME);
        if (!n) break;
        if (!gf) {
            in_rate = info.hz;
            in_ch = info.channels;
            out_ch = (channel_mode == CH_MONO || in_ch == 1) ? 1 : 2;
            int out_rate = rate < in_rate ? rate : in_rate; /* never upsample */
            gf = open_encoder(in_rate, out_ch, out_rate, mode, kbps, channel_mode, lowpass);
            if (!gf) fail("Encoder rejected settings");
            if (highpass) highpass_init(&hp, in_rate, HIGHPASS_HZ);
        } else if (info.hz != in_rate || info.channels != in_ch) {
            fail("Source changes format part-way through (%d Hz %dch -> %d Hz %dch)",
                 in_rate, in_ch, info.hz, info.channels);
        }

        int frames = (int) (n / (size_t) in_ch);
        int16_t *left = pcm;
        if (in_ch == 2 && out_ch == 1) {
            /* Downmix to mono by averaging the two channels. */
            if (mono_cap < (size_t) frames) {
                mono_cap = frames;
                mono = realloc(mono, mono_cap * sizeof(int16_t));
                if (!mono) fail("Out of memory");
            }
            for (int i = 0; i < frames; i++) mono[i] = (int16_t) (((int) pcm[2 * i] + pcm[2 * i + 1]) / 2);
            left = mono;
        }
        if (highpass) {
            if (out_ch == 1) highpass_apply(&hp, left, frames, 1);
            else highpass_apply(&hp, pcm, frames, 2);
        }

        size_t need = (size_t) (1.25 * frames + 7200);
        if (mp3_cap < need) {
            mp3_cap = need;
            mp3 = realloc(mp3, mp3_cap);
            if (!mp3) fail("Out of memory");
        }
        int written = out_ch == 1
            ? lame_encode_buffer(gf, left, NULL, frames, mp3, (int) mp3_cap)
            : lame_encode_buffer_interleaved(gf, pcm, frames, mp3, (int) mp3_cap);
        if (written < 0) fail("LAME encode error %d", written);
        write_all(out, mp3, (size_t) written);
        in_frames += (uint64_t) frames;

        if (dec.samples > 0) progress((double) (in_frames * (uint64_t) in_ch) / (double) dec.samples, &last_pct);
    }
    if (!gf) fail("Decoder produced no audio");

    if (mp3_cap < 7200) {
        mp3_cap = 7200;
        mp3 = realloc(mp3, mp3_cap);
        if (!mp3) fail("Out of memory");
    }
    int flushed = lame_encode_flush(gf, mp3, (int) mp3_cap);
    if (flushed < 0) fail("LAME flush error %d", flushed);
    write_all(out, mp3, (size_t) flushed);
    write_all(out, src + audio_end, size - audio_end); /* ID3v1 tag, byte for byte */

    /* VBR/ABR: LAME reserved the first frame; patch in the real Xing/LAME header so players show the right duration. */
    if (lame_get_bWriteVbrTag(gf)) {
        unsigned char tag[8192];
        size_t tag_len = lame_get_lametag_frame(gf, tag, sizeof tag);
        if (tag_len > 0 && tag_len <= sizeof tag) {
            if (fflush(out) || fseek(out, (long) audio_start, SEEK_SET)) fail("Can't write VBR header");
            write_all(out, tag, tag_len);
        }
    }
    if (fflush(out) || ferror(out)) fail("Can't write output (disk full?)");
    fclose(out);

    printf("result {\"inFrames\":%llu,\"inRate\":%d,\"inChannels\":%d,\"outRate\":%d,\"outChannels\":%d,\"decodeError\":%d}\n",
           (unsigned long long) in_frames, in_rate, in_ch, lame_get_out_samplerate(gf), out_ch, dec.last_error);
    fflush(stdout);
    lame_close(gf);
    mp3dec_ex_close(&dec);
    free(src);
    free(mono);
    free(mp3);
    return 0;
}

static int cmd_inspect(char **argv) {
    size_t size;
    uint8_t *src = read_all(argv[0], &size);
    static mp3dec_ex_t dec;
    if (mp3dec_ex_open_buf(&dec, src, size, MP3D_SEEK_TO_SAMPLE)) fail("Check failed: output isn't MP3");
    if (dec.info.layer != 3) fail("Check failed: output isn't MP3");

    int rate = 0, channels = 0, last_pct = -1, changed = 0;
    uint64_t samples = 0;
    double sum_squares = 0; /* for the RMS level, used by tests to check filters */
    for (;;) {
        mp3d_sample_t *pcm = NULL;
        mp3dec_frame_info_t info;
        size_t n = mp3dec_ex_read_frame(&dec, &pcm, &info, MINIMP3_MAX_SAMPLES_PER_FRAME);
        if (!n) break;
        if (!rate) {
            rate = info.hz;
            channels = info.channels;
        } else if (info.hz != rate || info.channels != channels) {
            changed = 1;
        }
        for (size_t i = 0; i < n; i++) sum_squares += (double) pcm[i] * pcm[i];
        samples += n;
        if (dec.samples > 0) progress((double) samples / (double) dec.samples, &last_pct);
    }
    if (!rate || !channels) fail("Check failed: output has no audio");
    printf("result {\"frames\":%llu,\"rate\":%d,\"channels\":%d,\"rms\":%.6f,\"formatChanged\":%d,\"decodeError\":%d}\n",
           (unsigned long long) (samples / (uint64_t) channels), rate, channels,
           sqrt(sum_squares / (double) samples) / 32768.0, changed, dec.last_error);
    fflush(stdout);
    mp3dec_ex_close(&dec);
    free(src);
    return 0;
}

static int run(int argc, char **argv) {
    if (argc >= 2 && !strcmp(argv[1], "version")) {
        printf("mp3bulk-engine %s (LAME %s, minimp3)\n", ENGINE_VERSION, get_lame_version());
        return 0;
    }
    if (argc == 12 && !strcmp(argv[1], "encode")) return cmd_encode(argv + 2);
    if (argc == 3 && !strcmp(argv[1], "inspect")) return cmd_inspect(argv + 2);
    fprintf(stderr, "usage: mp3bulk-engine version | encode IN OUT MODE KBPS RATE CHANNELS HIGHPASS LOWPASS AUDIO_START AUDIO_END | inspect IN\n");
    return 2;
}

int main(int argc, char **argv) {
#ifdef _WIN32
    /* Re-read the command line as UTF-16 and convert to UTF-8 so Unicode paths survive. */
    int wargc;
    LPWSTR *wargv = CommandLineToArgvW(GetCommandLineW(), &wargc);
    if (wargv) {
        char **u8 = calloc((size_t) wargc + 1, sizeof(char *));
        for (int i = 0; i < wargc; i++) {
            int len = WideCharToMultiByte(CP_UTF8, 0, wargv[i], -1, NULL, 0, NULL, NULL);
            u8[i] = malloc((size_t) len);
            WideCharToMultiByte(CP_UTF8, 0, wargv[i], -1, u8[i], len, NULL, NULL);
        }
        LocalFree(wargv);
        return run(wargc, u8);
    }
#endif
    return run(argc, argv);
}
