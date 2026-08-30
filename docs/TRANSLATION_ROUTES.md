# Object Translation in MotionLife

**Summary.** Objects can now travel across a scene while retaining their extracted motion.
The scarf in our reference artwork leaves the subject's hand, crosses the lake, and continues
to flutter throughout.

**Options considered.** Translation could be *derived from video* — tracking a moving subject,
such as a walking character, and reusing that trajectory — or *specified on the canvas* by
selecting a start and end point. The video-derived approach captures authentic timing and
cadence, which is difficult to author by hand. However, the resulting path exists in video
coordinates and carries no knowledge of the target artwork, so it still requires manual
placement and scaling; it also depends on subject tracking and camera-motion removal. Our
reference clip contains no usable translation at all, as the flag is fixed to a pole.

**Decision.** We implemented canvas-specified translation. Destination is fundamentally a
compositional choice that no source video can supply, and this approach requires no additional
services. It composes cleanly with extracted motion: measured shape distortion is identical
with and without travel, confirming that translation does not disturb the cloth simulation.

**Recommended next step.** A hybrid: derive the *timing profile* from video while retaining
user-specified destinations. This preserves the measured quality where it matters most and
avoids the limitations of purely video-derived paths.

**Input welcome on** export coverage (travel is currently captured in video export but not SVG
export) and on whether objects should rotate to follow their direction of travel.
