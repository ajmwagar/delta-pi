#!/usr/bin/env bash
# fleet.sh — which Delta threads exist on which of your machines, and pull the
# ones a machine is missing.
#
# Delta keeps a thread list per computer: a thread id is local to the machine
# that recorded it, and only the share id (`thread_…`) resolves elsewhere. So
# there is nothing to "sync" in the product sense — a machine learns about a
# thread by opening its link. This script closes that loop across your own
# machines, over ssh.
#
# Hosts come from --hosts, or from ~/.pi/agent/delta-fleet (one name per line).
#
#   ./fleet.sh                          # report only
#   ./fleet.sh --apply                  # pull what is missing
#   ./fleet.sh --apply --limit 3        # at most three pulls per machine
#   ./fleet.sh --hosts studio,neo       # ignore the configured list
#
# Deliberately opt-in per pull: a machine that clones every thread pays disk for
# conversations it never opens, and archived threads only free local history
# once the server holds a full copy.

set -uo pipefail

APPLY=0
LIMIT=0
HOSTS_ARG=""
INCLUDE_ARCHIVED=0

while [ $# -gt 0 ]; do
	case "$1" in
		--apply) APPLY=1 ;;
		--limit) LIMIT="${2:-0}"; shift ;;
		--hosts) HOSTS_ARG="${2:-}"; shift ;;
		--include-archived) INCLUDE_ARCHIVED=1 ;;
		-h|--help) sed -n '2,22p' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
		*) echo "fleet: unknown option $1" >&2; exit 2 ;;
	esac
	shift
done

FLEET_FILE="${DELTA_FLEET_FILE:-$HOME/.pi/agent/delta-fleet}"
FIND_DELTA='for c in "$HOME/Applications/Delta.app/Contents/MacOS/delta" "/Applications/Delta.app/Contents/MacOS/delta" "$HOME/.local/bin/delta" "$HOME/.local/delta.app/bin/delta"; do [ -x "$c" ] && { echo "$c"; exit 0; }; done; command -v delta'

local_names() {
	hostname -s 2>/dev/null | tr '[:upper:]' '[:lower:]'
	command -v tailscale >/dev/null 2>&1 && \
		tailscale status --json 2>/dev/null \
			| awk '/"Self"/{self=1} self && /"DNSName"/{print; exit}' \
			| sed 's/.*"DNSName": *"\([^".]*\).*/\1/' | tr '[:upper:]' '[:lower:]'
}

is_local() {
	local name lowered
	name="$1"
	[ "$name" = "local" ] && return 0
	lowered=$(printf '%s' "$name" | tr '[:upper:]' '[:lower:]')
	for known in $(local_names); do
		[ "$known" = "$lowered" ] && return 0
	done
	return 1
}

hosts() {
	if [ -n "$HOSTS_ARG" ]; then
		printf '%s\n' "$HOSTS_ARG" | tr ',' '\n' | sed 's/^ *//; s/ *$//' | sed '/^$/d'
	elif [ -f "$FLEET_FILE" ]; then
		sed 's/#.*//' "$FLEET_FILE" | sed 's/^ *//; s/ *$//' | sed '/^$/d'
	else
		echo "fleet: no hosts. Write one per line to $FLEET_FILE, or pass --hosts." >&2
		return 1
	fi
}

run_on() { # host command
	local host="$1" command="$2"
	if is_local "$host"; then
		sh -c "$command"
	else
		ssh -o BatchMode=yes -o ConnectTimeout=6 "$host" "$command"
	fi
}

delta_on() { # host
	local host="$1"
	if is_local "$host"; then
		sh -c "$FIND_DELTA" | tail -1
	else
		run_on "$host" "$FIND_DELTA" 2>/dev/null | tr -d '\r' | tail -1
	fi
}

# One `join_id<TAB>name` per line, newest last.
threads_on() { # host delta
	local host="$1" delta="$2" json
	json=$(run_on "$host" "'$delta' --json thread list" 2>/dev/null) || return 1
	[ -n "$json" ] || return 1
	if command -v jq >/dev/null 2>&1; then
		if [ "$INCLUDE_ARCHIVED" = "1" ]; then
			printf '%s' "$json" | jq -r '.[] | select(.join_id != null) | [.join_id, (.name // "")] | @tsv'
		else
			printf '%s' "$json" | jq -r '.[] | select(.join_id != null) | select(.archived != true) | [.join_id, (.name // "")] | @tsv'
		fi
	else
		printf '%s' "$json" | sed -n 's/.*"join_id": *"\(thread_[^"]*\)".*/\1/p'
	fi
}

pull_on() { # host delta join_id
	local host="$1" delta="$2" id="$3"
	run_on "$host" "'$delta' --json thread show https://delta.dev/join/$id --format summarize" >/dev/null 2>&1
}

ALL=$(hosts) || exit 1
CATALOG=$(mktemp)
trap 'rm -f "$CATALOG" "$CATALOG.count"' EXIT

for host in $ALL; do
	delta=$(delta_on "$host")
	if [ -z "$delta" ]; then
		echo "$host: unreachable or has no Delta CLI" >&2
		continue
	fi
	ids=$(threads_on "$host" "$delta") || { echo "$host: could not list threads" >&2; continue; }
	count=$(printf '%s\n' "$ids" | sed '/^$/d' | wc -l | tr -d ' ')
	total=$count
	if command -v jq >/dev/null 2>&1; then
		total=$(printf '%s' "$(run_on "$host" "'$delta' --json thread list" 2>/dev/null)" | jq 'length' 2>/dev/null || echo "$count")
	fi
	if [ "$total" != "$count" ]; then
		echo "$host: $count active threads ($total including archived)"
	else
		echo "$host: $count threads"
	fi
	printf '%s\n' "$ids" | sed '/^$/d' | while IFS= read -r line; do
		printf '%s\t%s\n' "${line%%	*}" "$host"
		printf '%s\t%s\n' "${line%%	*}" "$(printf '%s' "$line" | cut -f2-)" >> "$CATALOG.names"
	done >> "$CATALOG"
done

[ -s "$CATALOG" ] || exit 0

for host in $ALL; do
	pulled=0
	delta=$(delta_on "$host")
	[ -n "$delta" ] || continue
	own=$(printf '%s\n' "$(threads_on "$host" "$delta" 2>/dev/null)" | cut -f1 | sed '/^$/d' | sort -u)
	[ -n "$own" ] || continue
	missing=$(cut -f1 "$CATALOG" | sort -u | while read -r id; do
		printf '%s\n' "$own" | grep -qx "$id" || printf '%s\n' "$id"
	done)
	[ -n "$missing" ] || continue
	total=$(printf '%s\n' "$missing" | sed '/^$/d' | wc -l | tr -d ' ')
	echo ""
	echo "$host is missing $total:"
	for id in $missing; do
		if [ "$LIMIT" != "0" ] && [ "$pulled" -ge "$LIMIT" ]; then
			echo "  … limit $LIMIT reached"
			break
		fi
		name=$(grep -m1 "^$id	" "$CATALOG.names" 2>/dev/null | cut -f2-)
		if [ "$APPLY" = "1" ]; then
			if pull_on "$host" "$delta" "$id"; then
				echo "  pulled $id ${name:+— $name}"
				pulled=$((pulled + 1))
			else
				echo "  failed $id" >&2
			fi
		else
			echo "  would pull $id ${name:+— $name}"
		fi
	done
done

[ "$APPLY" = "1" ] || echo ""
[ "$APPLY" = "1" ] || echo "Report only. Add --apply to pull the missing threads."
