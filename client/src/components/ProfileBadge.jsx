import { Link } from "react-router-dom";

const ProfileBadge = ({ name = "User", avatarUrl, linkTo = "/profile" }) => {
  const initials = String(name)
    .split(" ")
    .map((n) => (n ? n[0] : ""))
    .slice(0, 2)
    .join("")
    .toUpperCase();

  const wrapper = { display: "flex", alignItems: "center", gap: 8, textDecoration: "none", color: "inherit" };
  const avatar = { width: 36, height: 36, borderRadius: "50%", background: "#1976d2", color: "#fff", display: "flex", alignItems: "center", justifyContent: "center", fontWeight: 600 };

  return (
    <Link to={linkTo} style={wrapper}>
      <div style={avatar} aria-hidden>
        {avatarUrl ? <img src={avatarUrl} alt={name} style={{ width: "100%", height: "100%", borderRadius: "50%" }} /> : initials}
      </div>
      <span>{name}</span>
    </Link>
  );
};

export default ProfileBadge;
