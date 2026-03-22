#pragma once

#include "diag.h"
#include <atomic>
#include <string>

// ===========================================================================
// KernelState — multi-dimensional state tracking.
//
// States exist on independent dimensions that can be active in parallel.
// For example: activity=Eval + dialog=DynDialog + sub=DynExpr is valid.
//
// Every dimension change goes through a Set*() helper that logs the
// transition via DiagLog.  The visual debugger parses these lines to
// render coloured horizontal bars for each dimension.
// ===========================================================================

// ---- Dimension 1: Activity — what main job the kernel is doing -----------
enum class Activity : int {
    Idle     = 0,
    Eval     = 1,
    SubIdle  = 2,
    WhenIdle = 3,
};
inline const char* Name(Activity s) {
    switch (s) {
        case Activity::Idle:     return "Idle";
        case Activity::Eval:     return "Eval";
        case Activity::SubIdle:  return "SubIdle";
        case Activity::WhenIdle: return "WhenIdle";
    }
    return "?";
}

// ---- Dimension 2: Dialog — what dialog subsession is open ----------------
enum class DialogState : int {
    None       = 0,
    UserDialog = 1,   // interactive Dialog[] subsession (visible to JS)
    DynDialog  = 2,   // C++-internal ScheduledTask Dialog[] for Dynamic eval
};
inline const char* Name(DialogState s) {
    switch (s) {
        case DialogState::None:       return "None";
        case DialogState::UserDialog: return "UserDialog";
        case DialogState::DynDialog:  return "DynDialog";
    }
    return "?";
}

// ---- Dimension 3: SubWork — what sub-work inside a dialog ----------------
enum class SubWork : int {
    None    = 0,
    DynExpr = 1,   // evaluating a registered Dynamic expression
    SubBusy = 2,   // subAuto() one-shot evaluation inside dialog
};
inline const char* Name(SubWork s) {
    switch (s) {
        case SubWork::None:    return "None";
        case SubWork::DynExpr: return "DynExpr";
        case SubWork::SubBusy: return "SubBusy";
    }
    return "?";
}

// ---- Dimension 4: Abort — whether an abort is in progress ----------------
enum class AbortState : int {
    None     = 0,
    Aborting = 1,
};
inline const char* Name(AbortState s) {
    switch (s) {
        case AbortState::None:     return "None";
        case AbortState::Aborting: return "Aborting";
    }
    return "?";
}

// ---- Dimension 5: Link — WSTP link health --------------------------------
enum class LinkState : int {
    Alive = 0,
    Dead  = 1,
};
inline const char* Name(LinkState s) {
    switch (s) {
        case LinkState::Alive: return "Alive";
        case LinkState::Dead:  return "Dead";
    }
    return "?";
}

// ===========================================================================
// KernelStatus — holds all dimensions together.
// Each dimension is a separate atomic so they can be updated independently
// from different threads without contention.
// ===========================================================================
struct KernelStatus {
    std::atomic<int> activity{static_cast<int>(Activity::Idle)};
    std::atomic<int> dialog{static_cast<int>(DialogState::None)};
    std::atomic<int> subWork{static_cast<int>(SubWork::None)};
    std::atomic<int> abort{static_cast<int>(AbortState::None)};
    std::atomic<int> link{static_cast<int>(LinkState::Alive)};
};

// ===========================================================================
// Transition helpers — log every change with [State:<dim>] tag.
// The visual debugger parses these to render coloured bars per dimension.
// Returns the previous value.
// ===========================================================================

inline Activity SetActivity(KernelStatus& st, Activity v, const char* caller) {
    int prev = st.activity.exchange(static_cast<int>(v));
    Activity old = static_cast<Activity>(prev);
    if (old != v)
        DiagLog(std::string("[State:activity] ") + Name(old) + " -> " + Name(v) + " (" + caller + ")");
    return old;
}
inline DialogState SetDialog(KernelStatus& st, DialogState v, const char* caller) {
    int prev = st.dialog.exchange(static_cast<int>(v));
    DialogState old = static_cast<DialogState>(prev);
    if (old != v)
        DiagLog(std::string("[State:dialog] ") + Name(old) + " -> " + Name(v) + " (" + caller + ")");
    return old;
}
inline SubWork SetSubWork(KernelStatus& st, SubWork v, const char* caller) {
    int prev = st.subWork.exchange(static_cast<int>(v));
    SubWork old = static_cast<SubWork>(prev);
    if (old != v)
        DiagLog(std::string("[State:sub] ") + Name(old) + " -> " + Name(v) + " (" + caller + ")");
    return old;
}
inline AbortState SetAbort(KernelStatus& st, AbortState v, const char* caller) {
    int prev = st.abort.exchange(static_cast<int>(v));
    AbortState old = static_cast<AbortState>(prev);
    if (old != v)
        DiagLog(std::string("[State:abort] ") + Name(old) + " -> " + Name(v) + " (" + caller + ")");
    return old;
}
inline LinkState SetLink(KernelStatus& st, LinkState v, const char* caller) {
    int prev = st.link.exchange(static_cast<int>(v));
    LinkState old = static_cast<LinkState>(prev);
    if (old != v)
        DiagLog(std::string("[State:link] ") + Name(old) + " -> " + Name(v) + " (" + caller + ")");
    return old;
}

// Getters
inline Activity    GetActivity(const KernelStatus& st) { return static_cast<Activity>(st.activity.load()); }
inline DialogState GetDialog  (const KernelStatus& st) { return static_cast<DialogState>(st.dialog.load()); }
inline SubWork     GetSubWork (const KernelStatus& st) { return static_cast<SubWork>(st.subWork.load()); }
inline AbortState  GetAbort   (const KernelStatus& st) { return static_cast<AbortState>(st.abort.load()); }
inline LinkState   GetLink    (const KernelStatus& st) { return static_cast<LinkState>(st.link.load()); }

// Full snapshot as a string — for JS accessor
inline std::string KernelStatusString(const KernelStatus& st) {
    return std::string("activity=") + Name(GetActivity(st)) +
           " dialog=" + Name(GetDialog(st)) +
           " sub=" + Name(GetSubWork(st)) +
           " abort=" + Name(GetAbort(st)) +
           " link=" + Name(GetLink(st));
}
