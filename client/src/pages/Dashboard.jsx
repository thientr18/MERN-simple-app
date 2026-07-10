import { useCallback, useEffect, useState } from 'react'
import "../styles/Dashboard.css";
import { Link, useNavigate } from 'react-router-dom';
import { toast } from 'react-toastify';
import axios from 'axios';
import ProfileBadge from "../components/ProfileBadge";

const Dashboard = () => {
  const [ token ] = useState(JSON.parse(localStorage.getItem("auth")) || "");
  const [ data, setData ] = useState({});
  const navigate = useNavigate();

  const fetchLuckyNumber = useCallback(async () => {

    let axiosConfig = {
      headers: {
        'Authorization': `Bearer ${token}`
    }
    };

    try {
      const response = await axios.get("/api/v1/dashboard", axiosConfig);
      setData({ msg: response.data.msg, luckyNumber: response.data.secret });
    } catch (error) {
      toast.error(error.message);
    }
  }, [token]);


  
  useEffect(() => {
    if(token === ""){
      navigate("/login");
      toast.warn("Please login first to access dashboard");
      return;
    }
    fetchLuckyNumber();
  }, [token, navigate, fetchLuckyNumber]);

  const displayName = data.msg && data.msg.includes(",") ? data.msg.split(',').pop().trim() : (data.msg || 'User');

  return (
    <div className='dashboard-main'>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', width: '100%', marginBottom: 16 }}>
        <ProfileBadge name={displayName} />
        <Link to="/logout" className="logout-button">Logout</Link>
      </div>

      <h1>{ data.msg }!</h1>
      <p>{ data.luckyNumber }</p>
    </div>
  )
}

export default Dashboard