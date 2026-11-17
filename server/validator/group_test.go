package main

import (
	"strings"
	"testing"
)

func TestGroupProjectBoundary(t *testing.T) {
	t.Setenv("HUB_GROUP_ID", "grp-test")
	h, n, _ := fixture(t)
	for _, key := range []string{"human_key", "project_key", "project_a", "project_b"} {
		for _, path := range []string{"/data/projects/grp-test2", "/data/projects/grp-test/../grp-test2", "grp-test2"} {
			w := post(t, h, "ensure_project", map[string]any{key: path})
			if !strings.Contains(w.Body.String(), "Group boundary") {
				t.Errorf("foreign %s accepted", key)
			}
		}
	}
	if n.Load() != 0 {
		t.Fatal("foreign project reached mail")
	}
	w := post(t, h, "ensure_project", map[string]any{"human_key": "/data/projects/grp-test"})
	if strings.Contains(w.Body.String(), "Group boundary") || n.Load() != 1 {
		t.Fatal("own project denied")
	}
}
