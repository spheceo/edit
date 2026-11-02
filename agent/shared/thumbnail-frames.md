## From the case's video

How the team builds most thumbnails (Sphe, Nov 2: "usually we have the thumbnail references in our head and we then take frames from the youtube video"): **the reference gives the idea, the video gives the pictures.** For a case with a YouTube video, look at it before you settle the subject's picture on "find an image of…":

1. `scan_video` and read every sheet: what scenes the video has (outside the house, inside it, the car, the room), who is in them, and where each person is seen clearly. The transcript's times say who is talking when. On a long video the sheets are spread (it says so): scan the stretches the transcript points to (the find, the arrest, the confrontation) before you choose, and never say someone "isn't clear in any frame" from the spread look alone.
2. Choose the concept from the approved thumbnails (the references): what they show and how (the pose, the look, where the person stands in the scene). Then find this case's version of it in the video.
3. `grab_frames` at the moments that could give it (a few seconds apart around each; the storyboard is only a sketch), and read each frame. Keep only a frame where the face is clear and the scene reads at a glance.

Then take, on purpose (the user: "we pick the base frame e.g outside the house, inside the house, etc. and we pick the subjects, e.g the father, the child"):

- **a base and its subjects from different frames:** the scene from one (use `base`), each person from the frame that shows them best (use `subject`, who: "the father"); the guide says where each goes in the base;
- **base and subject in one frame** (use `base_and_subject`): the frame is nearly the thumbnail, and the guide changes only what it must. The user: "this has to be very intentional sometimes we need very little manipulation e.g have the father look into the eyes of the POV (which just means looking just above the body camera) or it's have the daughter look bruised and sad." Every change is one the reference shows working and the case supports (a bruise only when the source says she was hurt); none is there just to change something.

"the ideas for how to do this will come from the reference images we're giving to the agent": name the approved card you follow in `base_card`. With a base frame it goes on the card as the reference, after the frames.

`subject_from: "video"` with the frames in `frames` (each by the time `grab_frames` gave back, the base first). The card shows them in that order, so the guide names each by its place, never its time (the user: "it should rather say, "use the first frame here..." it should know the order in which the frames will be shown to the user"):

`use the first frame as the base. take the father from the second frame and stand him at the front door. have the father look just above the camera.`

`use the first frame with the daughter in it. have the daughter look bruised and sad.`

How the team says it (the user, Nov 2, on the first try's guide):

- **Never into the camera.** "we never want subjects looking into the camera, instead we have them "look into the eyes of the POV" or "look just above the camera"".
- **What the editor can make, not the moment.** Not "mid-sentence": "with her mouth a bit open, almost like she is talking". Only when the reference shows someone speaking and the hook is what they say; most subjects need no word about their mouth (the user, the next day's guides: "we are using this WAY too much now"). The same for "just above the camera": say it when where they look matters, not by habit.
- **No blurred faces.** "for thumbnails we shouldnt have faces blurred": a frame where police blurred someone is fine to use, but the guide describes them as they should look (`holding the baby against her chest.`), never "blurred".
- **Move the bodycam's angle when it hides the subject.** The camera sits at an officer's chest, so a frame often cuts the subject off at the shoulders or shows them from below. Look at the base frame for it, and say how to move it so the thumbnail shows them: "move the camera angle up so that we can see the upper body of the mom and baby". On a frame of the video this is the one camera direction a guide gives (the editorial guide's "no crop, framing, camera angle" is about the approved thumbnails' bases).
- **Not the clean-up.** "no need to say, remove subtitles or remove overlays as we do this anyway": the burned-in captions, the bodycam's stamp and the channel's logo always go; the guide never mentions them.
- **Text rarely, and never in capitals.** "we rarely ever have all caps for our text and we rarely ever have text to begin with": most of these thumbnails have no text. Add a caption only when the picture can't carry the title's hook by itself, in its words' own case (`add “She knew” text.`).

## Something new, not the original again

The case's own YouTube thumbnail is the picture the viewer may already have seen. Ours shows them something new (the user, Nov 2, on a guide that put the woman from the original thumbnail back in a box on the porch: "this is way too similar to the original thumbnail. I do like us to have a bit of novelty there, at least if we're going to change some things up. We change up the environments. We can still use the exact same frame, but we can then give instructions for how to change up the environments.").

- Taking the subject from the original thumbnail is right when the video can't give them (blurred by police, never clear): "Take the woman from the original thumbnail. That is perfect, and that's how we would do it if we have a situation like this where she's blurred."
- Then the environment changes: a different scene of the case (the basement she was kept in rather than the porch she was found on, the house from outside, the room of the interview), from a frame of the video or said in the guide (`put her in the dark basement from the first frame.`, `change the cluttered porch to a bare concrete basement.`). The same frame may stay the base when the guide changes what's around the subject.
- Before saving, put the two side by side: if a viewer who saw the original would think it's the same picture, change the environment or the moment. `new_from_original` says in a line what's new.

Here a frame of the case's video is the base (the editorial guide's "never alternative bases" is about pictures from outside the video). The scene elements and edits come from what the frame and the reference show, as the inspection above says. When no frame shows the subject clearly (always masked, out of shot, too dark), say so in one line and use the original thumbnail or "find an image of…" as above.
