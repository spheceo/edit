//! What the agent is taught for each kind of video (a project's style:
//! bodycam, interrogation, courtroom). They all share the house style
//! (`mcp::INSTRUCTIONS` and `skills::SKILLS`) for now. A style's own rules go
//! in its guide: `notes` are added to the agent's instructions, and `skills`
//! are added to the shared ones (one with a shared skill's name replaces it
//! for that style), so the effects stay the same and what the agent picks
//! from them can differ.

use edit_core::Style;

use crate::skills::Skill;

pub struct Guide {
    /// Rules for this kind of video only, read after the house style.
    pub notes: &'static str,
    /// Its own skills, and its versions of shared ones.
    pub skills: &'static [Skill],
}

const BODYCAM: Guide = Guide {
    notes: "",
    skills: &[],
};

const INTERROGATION: Guide = Guide {
    notes: "",
    skills: &[],
};

const COURTROOM: Guide = Guide {
    notes: "",
    skills: &[],
};

pub fn guide(style: Style) -> &'static Guide {
    match style {
        Style::Bodycam => &BODYCAM,
        Style::Interrogation => &INTERROGATION,
        Style::Courtroom => &COURTROOM,
    }
}

/// The skill called `name` for this style: its own version, else the house one.
pub fn skill(style: Style, name: &str) -> Option<&'static Skill> {
    guide(style)
        .skills
        .iter()
        .find(|skill| skill.name == name)
        .or_else(|| crate::skills::get(name))
}

/// The skills this style can load.
pub fn skill_names(style: Style) -> Vec<&'static str> {
    let mut names: Vec<&str> = crate::skills::SKILLS
        .iter()
        .map(|skill| skill.name)
        .collect();
    for skill in guide(style).skills {
        if !names.contains(&skill.name) {
            names.push(skill.name);
        }
    }
    names
}

/// Every skill name across the styles (the skill tool's choices).
pub fn all_skill_names() -> Vec<&'static str> {
    let mut names = Vec::new();
    for style in Style::ALL {
        for name in skill_names(style) {
            if !names.contains(&name) {
                names.push(name);
            }
        }
    }
    names
}

/// What the agent's instructions say about the project's style.
pub fn instructions(style: Style) -> String {
    let notes = guide(style).notes.trim();
    let mut out = format!(
        "THIS VIDEO'S STYLE: {}. The house style above applies to it",
        style.name()
    );
    if notes.is_empty() {
        out.push('.');
    } else {
        out.push_str(", with these rules for this kind of video (they win where they differ):\n");
        out.push_str(notes);
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn every_style_has_the_house_skills() {
        for style in Style::ALL {
            for skill in crate::skills::SKILLS {
                assert!(skill_names(style).contains(&skill.name));
                assert!(super::skill(style, skill.name).is_some());
            }
            assert!(instructions(style).contains(style.name()));
        }
    }
}
