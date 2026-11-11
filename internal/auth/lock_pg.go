package auth

import "gorm.io/gorm/clause"

func lockForUpdate() clause.Expression { return clause.Locking{Strength: "UPDATE"} }
