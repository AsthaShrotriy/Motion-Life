"""Is MediaPipe's depth good enough to recover the stride our 2D angles miss?

We store (x, y, visibility) and DROP lm.z (pose_server.py:62,253). For a subject walking
away from camera the thigh swing lives almost entirely in z, so if z is usable the stride is
recoverable; if z is noise, it is not. Measure, do not assume.

Compares three readings of the same clip:
  2D image        atan2(dy, dx) of hip->knee            <- what the rig uses today
  z (image)       lm.z, normalised roughly like x       <- the field we throw away
  world 3D        pose_world_landmarks, metres, hip-centred, sagittal plane
"""
import math
import sys
import cv2
import mediapipe as mp

VIDEO = sys.argv[1] if len(sys.argv) > 1 else "assets/videos/walk-man.mp4"
IDX = {"l_sho": 11, "r_sho": 12, "l_hip": 23, "r_hip": 24,
       "l_knee": 25, "r_knee": 26, "l_ank": 27, "r_ank": 28}
MP = mp.solutions.pose

cap = cv2.VideoCapture(VIDEO)
fps = cap.get(cv2.CAP_PROP_FPS) or 30
step = max(1, round(fps / 15))
frames, i = [], 0
while len(frames) < 160:
    ok, fr = cap.read()
    if not ok:
        break
    if i % step == 0:
        frames.append(fr)
    i += 1
cap.release()
print(f"{VIDEO}: {len(frames)} sampled frames @15fps (src {fps:.2f}fps)")

img, wrl, vis = [], [], []
with MP.Pose(model_complexity=1, min_detection_confidence=0.5,
             min_tracking_confidence=0.5) as pose:
    for fr in frames:
        res = pose.process(cv2.cvtColor(fr, cv2.COLOR_BGR2RGB))
        if not res.pose_landmarks:
            img.append(None); wrl.append(None); vis.append(None); continue
        lm = res.pose_landmarks.landmark
        img.append({n: (lm[k].x, lm[k].y, lm[k].z) for n, k in IDX.items()})
        vis.append({n: lm[k].visibility for n, k in IDX.items()})
        w = res.pose_world_landmarks
        wrl.append({n: (w.landmark[k].x, w.landmark[k].y, w.landmark[k].z)
                    for n, k in IDX.items()} if w else None)

ok_i = [k for k, v in enumerate(img) if v]
print(f"detected {len(ok_i)}/{len(frames)}, world landmarks on "
      f"{sum(1 for w in wrl if w)}/{len(frames)}")


def swing(series, get):
    """peak-to-peak of an angle series, plus the series itself"""
    a = [get(s) for s in series if s]
    if not a:
        return 0, []
    return max(a) - min(a), a


def corr(a, b):
    n = min(len(a), len(b))
    if n < 3:
        return float("nan")
    a, b = a[:n], b[:n]
    ma, mb = sum(a) / n, sum(b) / n
    va = sum((x - ma) ** 2 for x in a); vb = sum((y - mb) ** 2 for y in b)
    if va == 0 or vb == 0:
        return float("nan")
    return sum((a[k] - ma) * (b[k] - mb) for k in range(n)) / math.sqrt(va * vb)


def jitter(a):
    """mean absolute frame-to-frame change — noise floor of the signal, in degrees"""
    if len(a) < 2:
        return float("nan")
    return sum(abs(a[k] - a[k - 1]) for k in range(1, len(a))) / (len(a) - 1)


rows = []
for side in ("l", "r"):
    hip, knee = f"{side}_hip", f"{side}_knee"
    s2, a2 = swing(img, lambda s: math.degrees(
        math.atan2(s[knee][1] - s[hip][1], s[knee][0] - s[hip][0])))
    sz, az = swing(img, lambda s: math.degrees(
        math.atan2(s[knee][2] - s[hip][2], s[knee][1] - s[hip][1])))
    sw, aw = swing(wrl, lambda s: math.degrees(
        math.atan2(s[knee][2] - s[hip][2], s[knee][1] - s[hip][1])))
    rows.append((side, (s2, a2), (sz, az), (sw, aw)))

print(f"\nthigh swing, peak-to-peak (and per-frame jitter = noise floor)")
print(f"  {'reading':16s} {'leg-l':>18s} {'leg-r':>18s}   antiphase corr")
for name, k in (("2D image angle", 1), ("z (image depth)", 2), ("world 3D sagittal", 3)):
    L, R = rows[0][k], rows[1][k]
    c = corr(L[1], R[1])
    print(f"  {name:16s} {L[0]:8.1f}deg j{jitter(L[1]):5.1f} "
          f"{R[0]:8.1f}deg j{jitter(R[1]):5.1f}   {c:+.3f}")

# how much of the stride is depth? compare hip->knee displacement variance per axis
for side in ("l", "r"):
    hip, knee = f"{side}_hip", f"{side}_knee"
    axes = {}
    for ax, name in ((0, "x"), (1, "y"), (2, "z")):
        v = [s[knee][ax] - s[hip][ax] for s in wrl if s]
        m = sum(v) / len(v)
        axes[name] = math.sqrt(sum((q - m) ** 2 for q in v) / len(v))
    tot = sum(axes.values()) or 1
    print(f"  thigh vector spread, world, leg-{side}: "
          + "  ".join(f"{k}={v:.4f}m ({100*v/tot:.0f}%)" for k, v in axes.items()))

mv = [min(v[n] for n in ("l_hip", "l_knee", "r_hip", "r_knee")) for v in vis if v]
print(f"\nmin leg-landmark visibility: mean {sum(mv)/len(mv):.3f}, worst {min(mv):.3f}")
